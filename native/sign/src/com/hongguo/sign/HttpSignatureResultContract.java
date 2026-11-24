package com.hongguo.sign;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Strict private native-result parsing; no diagnostic key/value projection. */
public final class HttpSignatureResultContract {
    private static final Map<String,String> SECURITY=new LinkedHashMap<String,String>();
    static {
        for(String name:Arrays.asList("X-Argus","X-Gorgon","X-Helios","X-Khronos","X-Ladon","X-Medusa"))
            SECURITY.put(name.toLowerCase(Locale.ROOT),name);
    }
    private HttpSignatureResultContract() {}
    public static Inspection inspect(Object raw) {
        Inspection result=new Inspection();
        if(!(raw instanceof String[]) || ((((String[])raw).length)&1)!=0) return result;
        String[] pairs=(String[])raw; result.valid=true;
        for(int i=0;i<pairs.length;i+=2) {
            String key=pairs[i],value=pairs[i+1];
            if(key==null || value==null) {result.valid=false;continue;}
            if(value.indexOf('\r')>=0 || value.indexOf('\n')>=0) {result.valid=false;continue;}
            String canonical=SECURITY.get(key.toLowerCase(Locale.ROOT));
            if(canonical!=null && !value.isEmpty()) result.signatures.put(canonical,value);
        }
        return result;
    }
    public static final class Inspection implements AutoCloseable {
        private boolean valid;
        private final Map<String,String> signatures=new LinkedHashMap<String,String>();
        public Map<String,String> requireSecurityHeaders() {
            if(!valid || !signatures.keySet().containsAll(Arrays.asList("X-Argus","X-Gorgon","X-Khronos")))
                throw new IllegalStateException("Signing failed");
            return new LinkedHashMap<String,String>(signatures);
        }
        public void close() {signatures.clear();valid=false;}
        public String toString() {return "SignatureInspection[private]";}
    }
}
