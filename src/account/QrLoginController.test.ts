import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridge, QrLoginState, Session } from '../../shared/contracts';
import { isQrImage, QrLoginController, type QrLoginView } from './QrLoginController';

const firstId = 'a'.repeat(32), secondId = 'b'.repeat(32);
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYp8AAAAASUVORK5CYII=';
const otherImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';
const session: Session = { loggedIn: true, uid: 'synthetic-user', nickname: '测试', avatar: '', mobile: '' };
const ticket = (id = firstId, extra: Partial<QrLoginState> = {}): QrLoginState => ({ id, status: 'waiting',
  expiresAt: (Date.now() + 60000) / 1000, pollAfter: 1.5, message: '等待扫码', imageDataUrl: image, ...extra });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
type Call = { path: string; options: Parameters<NativeBridge['request']>[1]; resolve: (data: unknown) => void; reject: (error: Error) => void };

function fixture() {
  const calls: Call[] = [], events: QrLoginView[] = [], confirmed = vi.fn();
  const request = vi.fn((path: string, options?: Parameters<NativeBridge['request']>[1]) => {
    if (options?.method === 'DELETE') return Promise.resolve({});
    return new Promise<unknown>((resolve, reject) => calls.push({ path, options, resolve, reject }));
  });
  const controller = new QrLoginController({ request: request as NativeBridge['request'], onState: state => events.push(state), onConfirmed: confirmed });
  const start = async (data = ticket()) => { const pending = controller.start(); calls.at(-1)!.resolve(data); await pending; return data; };
  return { controller, calls, request, events, confirmed, start, last: () => events.at(-1)! };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('QR login lifecycle', () => {
  it('starts only when requested and shares a pending creation', async () => {
    const f = fixture(); expect(f.request).not.toHaveBeenCalled(); const first = f.controller.start(); expect(f.controller.start()).toBe(first);
    expect(f.calls).toHaveLength(1); f.calls[0].resolve(ticket()); await first;
    expect(f.last().imageDataUrl).toBe(image); expect(f.last().status).toBe('waiting'); f.controller.close();
  });
  it('shares an in-flight poll across repeated visibility events', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500); f.controller.setVisible(false); f.controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(3000); expect(f.calls.filter(call => call.path.endsWith(firstId))).toHaveLength(1);
    f.calls[1].resolve(ticket(firstId, { imageDataUrl: undefined })); await tick(); f.controller.close();
  });
  it('leaving during POST still cancels the late allocated QR attempt', async () => {
    const f = fixture(); const pending = f.controller.start(); f.controller.close(); f.calls[0].resolve(ticket()); await pending;
    expect(f.request.mock.calls.filter(call => call[1]?.method === 'DELETE')).toEqual([[`/account/qr/${firstId}`, { method: 'DELETE', timeout: 10000 }]]);
    expect(f.events.some(state => state.status === 'waiting')).toBe(false); expect(f.confirmed).not.toHaveBeenCalled();
  });
  it('refresh retires the old attempt and rejects its late confirmation', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    const refresh = f.controller.start(); f.calls[1].resolve(ticket(firstId, { status: 'confirmed', session })); await tick();
    f.calls[2].resolve(ticket(secondId)); await refresh;
    expect(f.last().id).toBe(secondId); expect(f.last().status).toBe('waiting'); expect(f.confirmed).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(call => call[0] === `/account/qr/${firstId}` && call[1]?.method === 'DELETE')).toBe(true); f.controller.close();
  });
  it('confirmed handover calls the login completion exactly once', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve(ticket(firstId, { status: 'confirmed', session })); await tick(); f.controller.setVisible(true); await vi.advanceTimersByTimeAsync(10000);
    expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(session); expect(f.last().status).toBe('confirmed'); expect(f.last().imageDataUrl).toBeUndefined();
    expect(f.calls).toHaveLength(2); f.controller.close();
  });
  it('phone scanning alone never completes the account login', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve(ticket(firstId, { status: 'scanned', imageDataUrl: undefined })); await tick();
    expect(f.last().status).toBe('scanned'); expect(f.last().imageDataUrl).toBe(image); expect(f.confirmed).not.toHaveBeenCalled(); f.controller.close();
  });
  it('a confirmation without an authenticated mobile session is rejected', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve(ticket(firstId, { status: 'confirmed', session: { ...session, loggedIn: false } })); await tick();
    expect(f.last().status).toBe('failed'); expect(f.last().imageDataUrl).toBeUndefined(); expect(f.confirmed).not.toHaveBeenCalled(); f.controller.close();
  });
  it('only public Session fields cross the account completion callback', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve({ ...ticket(), status: 'confirmed', session: { ...session, cookie: 'synthetic-not-public', token: 'synthetic-not-public' } }); await tick();
    expect(f.confirmed).toHaveBeenCalledWith(session); expect(JSON.stringify(f.events)).not.toContain('synthetic-not-public'); f.controller.close();
  });
  it('hidden views pause polling and resume without creating a second QR', async () => {
    const f = fixture(); await f.start(); f.controller.setVisible(false); await vi.advanceTimersByTimeAsync(3000);
    expect(f.calls).toHaveLength(1); f.controller.setVisible(true); expect(f.calls).toHaveLength(2); expect(f.calls[1].path).toBe(`/account/qr/${firstId}`); f.controller.close();
  });
  it('expiration clears the image while hidden and prevents resumed polling', async () => {
    const f = fixture(); await f.start(ticket(firstId, { expiresAt: (Date.now() + 2000) / 1000 })); f.controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(2000); expect(f.last().status).toBe('expired'); expect(f.last().imageDataUrl).toBeUndefined();
    f.controller.setVisible(true); expect(f.calls).toHaveLength(1); f.controller.close();
  });
  it('an already expired response never publishes a scannable image', async () => {
    const f = fixture(); await f.start(ticket(firstId, { expiresAt: Date.now() / 1000 - 1 }));
    expect(f.last().status).toBe('expired'); expect(f.events.some(state => state.imageDataUrl)).toBe(false); f.controller.close();
  });
  it('a failed poll preserves its image and retries after a short delay', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500); f.calls[1].reject(new Error('synthetic-network-error')); await tick();
    expect(f.last().imageDataUrl).toBe(image); expect(f.last().message).toContain('重试');
    await vi.advanceTimersByTimeAsync(1999); expect(f.calls).toHaveLength(2); await vi.advanceTimersByTimeAsync(1); expect(f.calls).toHaveLength(3);
    f.calls[2].resolve(ticket(firstId, { imageDataUrl: undefined })); await tick(); expect(f.last().message).toBe('等待扫码'); f.controller.close();
  });
  it('poll retries are bounded and never show sensitive exception values', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    for (let attempt = 0; attempt < 4; attempt++) {
      f.calls.at(-1)!.reject(new Error('token=synthetic-not-public')); await tick(); if (attempt < 3) await vi.advanceTimersByTimeAsync(2000);
    }
    expect(f.last().status).toBe('failed'); expect(f.last().imageDataUrl).toBeUndefined(); expect(f.calls).toHaveLength(5);
    expect(JSON.stringify(f.events)).not.toContain('synthetic-not-public'); f.controller.close();
  });
  it('creation retries are bounded and cancel during backoff is immediate', async () => {
    const f = fixture(), pending = f.controller.start(); f.calls[0].reject(new Error('offline')); await tick(); f.controller.cancel(); await pending;
    await vi.advanceTimersByTimeAsync(5000); expect(f.calls).toHaveLength(1); expect(f.last().status).toBe('cancelled'); f.controller.close();
    const g = fixture(), creating = g.controller.start();
    for (let attempt = 0; attempt < 4; attempt++) { g.calls.at(-1)!.reject(new Error('offline')); await tick(); if (attempt < 3) await vi.advanceTimersByTimeAsync(2000); }
    await creating; expect(g.last().status).toBe('failed'); expect(g.calls).toHaveLength(4); g.controller.close();
  });
  it('requesting cancellation never logs out or mutates an existing account', async () => {
    const f = fixture(); await f.start(); f.controller.cancel(); await tick();
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['/account/qr', `/account/qr/${firstId}`]); expect(f.confirmed).not.toHaveBeenCalled(); f.controller.close();
  });
  it('mismatched state cannot confirm or cancel an unrelated attempt', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve(ticket(secondId, { status: 'confirmed', session })); await tick(); expect(f.last().status).toBe('failed');
    expect(f.request.mock.calls.some(call => call[0].includes(secondId))).toBe(false); expect(f.confirmed).not.toHaveBeenCalled(); f.controller.close();
  });
  it('refreshed images remain local PNG or JPEG data without remote URLs', async () => {
    const f = fixture(); await f.start(); await vi.advanceTimersByTimeAsync(1500);
    f.calls[1].resolve(ticket(firstId, { imageDataUrl: otherImage })); await tick(); expect(f.last().imageDataUrl).toBe(otherImage); f.controller.close();
    expect(isQrImage(image)).toBe(true); expect(isQrImage(otherImage)).toBe(true);
    for (const invalid of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,bad$']) expect(isQrImage(invalid)).toBe(false);
  });
  it('invalid pictures and nonlocal attempt identifiers are rejected', async () => {
    for (const invalid of [ticket(firstId, { imageDataUrl: 'https://example.com/qr.png' }), ticket('foreign/id')]) {
      const f = fixture(); await f.start(invalid); expect(f.last().status).toBe('failed'); expect(f.last().imageDataUrl).toBeUndefined();
      expect(f.request.mock.calls.some(call => call[0].includes('foreign'))).toBe(false); f.controller.close();
    }
  });
});
