package com.hongguo.sign;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/** One thread owns one identity-bound context. Identity values never have a public representation. */
public final class IdentityBoundSignerWorker implements AutoCloseable {
    public interface Context {
        Map<String,String> sign(HeaderContract.SigningRequest request) throws Exception;
        void close() throws Exception;
    }
    public interface Factory { Context create() throws Exception; }
    /** The process owner must terminate/restart if resource teardown cannot be confirmed. */
    public static final class ContextCloseFailure extends IllegalStateException {
        private ContextCloseFailure() { super("Signer context teardown failed"); }
    }
    private static final String[] IDENTITY_KEYS = {"aid","device_id","iid","version_name","version_code"};
    private final Factory factory;
    private Context context;
    private byte[] identityKey;
    private boolean closed;
    private boolean terminalFailure;

    public IdentityBoundSignerWorker(Factory factory) {
        if (factory == null) throw new IllegalArgumentException("Invalid signer factory");
        this.factory=factory;
    }
    public synchronized Map<String,String> sign(HeaderContract.SigningRequest request) throws Exception {
        if (closed || terminalFailure || request == null) throw new IllegalStateException("Signer unavailable");
        byte[] candidate=keyOf(request.url());
        try {
            if (context != null && !MessageDigest.isEqual(identityKey,candidate)) discard();
            if (context == null) {
                try { context=factory.create(); }
                catch (Throwable ignored) { throw new IllegalStateException("Signer initialization failed"); }
                if (context == null) throw new IllegalStateException("Signer initialization failed");
                identityKey=candidate.clone();
            }
            try {
                Map<String,String> result=context.sign(request);
                if(result==null)throw new IllegalStateException("Signing failed");
                return result;
            }
            catch (Throwable ignored) {
                discard();
                throw new IllegalStateException("Signing failed");
            }
        } finally { Arrays.fill(candidate,(byte)0); }
    }
    private void discard() throws Exception {
        Context previous=context; context=null;
        if (identityKey != null) Arrays.fill(identityKey,(byte)0);
        identityKey=null;
        if (previous == null) return;
        try { previous.close(); }
        catch (Throwable ignored) { terminalFailure=true; throw new ContextCloseFailure(); }
    }
    public synchronized void close() throws Exception {
        if (closed) return;
        closed=true; discard();
    }
    static Map<String,String> identityValues(String url) {
        Map<String,String> values=new HashMap<String,String>();
        try {
            String query=new URI(url).getRawQuery();
            if (query != null) for (String component:query.split("&")) {
                String[] pair=component.split("=",2);
                String name=URLDecoder.decode(pair[0],"UTF-8");
                boolean identity=false;
                for (String key:IDENTITY_KEYS) if (key.equals(name)) {identity=true;break;}
                if (!identity) continue;
                if (values.containsKey(name)) throw new IllegalArgumentException();
                values.put(name,pair.length==2?URLDecoder.decode(pair[1],"UTF-8"):"");
            }
            return values;
        } catch (Throwable ignored) { values.clear(); throw new IllegalArgumentException("Invalid signer identity"); }
    }
    private static byte[] keyOf(String url) {
        Map<String,String> values=identityValues(url);
        try {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            for (String key:IDENTITY_KEYS) {
                byte[] bytes=values.getOrDefault(key,"").getBytes(StandardCharsets.UTF_8);
                try {
                    digest.update((byte)(bytes.length>>>24)); digest.update((byte)(bytes.length>>>16));
                    digest.update((byte)(bytes.length>>>8)); digest.update((byte)bytes.length); digest.update(bytes);
                } finally {Arrays.fill(bytes,(byte)0);}
            }
            return digest.digest();
        } catch (Throwable ignored) {throw new IllegalStateException("Invalid signer identity");}
        finally {values.clear();}
    }
    public String toString() {return "IdentityBoundSignerWorker[private]";}
}
