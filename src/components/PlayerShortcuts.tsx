import './PlayerShortcuts.css';

const shortcuts = [
  { action: 'toggle', keys: [' ', 'k'], labels: ['空格', 'K'], description: '播放 / 暂停' },
  { action: 'seek', keys: ['arrowleft', 'arrowright'], labels: ['← / →'], description: '快退 / 快进 5 秒' },
  { action: 'fineSeek', keys: ['arrowleft', 'arrowright'], shift: true, labels: ['Shift + ← / →'], description: '快退 / 快进 1 秒' },
  { action: 'percent', keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], labels: ['0–9'], description: '定位到 0%–90%' },
  { action: 'volume', keys: ['arrowup', 'arrowdown'], labels: ['↑ / ↓'], description: '调高 / 调低音量' },
  { action: 'mute', keys: ['m'], labels: ['M'], description: '静音 / 恢复声音' },
  { action: 'rate', keys: ['[', ']'], labels: ['[ / ]'], description: '减慢 / 加快倍速' },
  { action: 'next', keys: ['j', 'n'], labels: ['J', 'N'], description: '播放下一集 / 下一季' },
  { action: 'danmaku', keys: ['d'], labels: ['D'], description: '开关弹幕' },
  { action: 'theater', keys: ['t'], labels: ['T'], description: '窗口全屏' },
  { action: 'fullscreen', keys: ['f'], labels: ['F'], description: '系统全屏' },
  { action: 'help', keys: ['?'], labels: ['?'], description: '查看快捷键' },
  { action: 'escape', keys: ['escape'], labels: ['Esc'], description: '关闭面板 / 退出全屏 / 返回' },
] as const;

export function playerShortcut(key: string, shift: boolean) {
  const matches = (shortcut: typeof shortcuts[number]) => shortcut.keys.some(binding => binding === key);
  const modified = shift && shortcuts.find(shortcut => 'shift' in shortcut && matches(shortcut));
  return (modified || shortcuts.find(shortcut => !('shift' in shortcut) && matches(shortcut)))?.action;
}

export function PlayerShortcutGuide() {
  return <ul className="player-shortcut-list">
    {shortcuts.map(({ action, labels, description }) => <li key={action}>
      <span>{description}</span>
      <span className="player-shortcut-keys">{labels.map(label => <kbd key={label}>{label}</kbd>)}</span>
    </li>)}
  </ul>;
}
