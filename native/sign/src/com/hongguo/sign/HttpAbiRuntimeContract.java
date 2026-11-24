package com.hongguo.sign;

/** Current 74332 static contracts; long values never have a public representation. */
public final class HttpAbiRuntimeContract {
    public static final String DISPATCHER_CLASS = "ms/bd/c/k3";
    public static final String FACADE_PARENT_CLASS = "ms/bd/c/q2";
    public static final String FACADE_CLASS = "com/bytedance/mobsec/metasec/ml/MS";
    public static final String DEFAULT_REPORT_HOST = "";
    public static final int HTTP_MANAGER_CALLBACK_OPCODE = 33554433;
    public static final int OTHER_MANAGER_CALLBACK_OPCODE = 33554434;
    public static final int CONFIG_INIT_OPCODE = 67108865;
    public static final int REPORT_HOST_OPCODE = 33554449;
    private static final String CALLBACK_DESCRIPTOR = "->b(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;";
    private HttpAbiRuntimeContract() {}
    public static boolean isFacadeCallback(String signature) {
        return (FACADE_CLASS + CALLBACK_DESCRIPTOR).equals(signature) ||
                (FACADE_PARENT_CLASS + CALLBACK_DESCRIPTOR).equals(signature) ||
                (DISPATCHER_CLASS + CALLBACK_DESCRIPTOR).equals(signature);
    }
    public static int[] initializationOpcodes(String reportHost) {
        if (reportHost == null) throw new IllegalArgumentException("Invalid SDK init contract");
        return reportHost.isEmpty() ? new int[]{CONFIG_INIT_OPCODE} : new int[]{REPORT_HOST_OPCODE,CONFIG_INIT_OPCODE};
    }
    public static final class CallbackState {
        private long httpManager;
        private boolean seen;
        private boolean exactSetterSeen;
        public synchronized boolean acceptOpcode(int opcode,long callbackLong) {
            if (opcode != HTTP_MANAGER_CALLBACK_OPCODE) return false;
            httpManager=callbackLong; seen=true; return true;
        }
        public synchronized void noteExactSetter(String signature,String receiverClass) {
            if ("ms/bd/c/a3->b(J)V".equals(signature) && "ms/bd/c/h5".equals(receiverClass)) exactSetterSeen=true;
            // Static a3 setter observation alone does not identify its HTTP caller.
        }
        public synchronized void reset() {httpManager=0L;seen=false;exactSetterSeen=false;}
        public synchronized boolean seen() { return seen; }
        public synchronized boolean exactSetterSeen() { return exactSetterSeen; }
        public synchronized boolean nonzero() { return seen && httpManager != 0L; }
        public synchronized long httpManagerForNative() {
            if (!nonzero()) throw new IllegalStateException("HTTP manager callback unavailable");
            return httpManager;
        }
        public synchronized boolean comparisonAvailable(long legacy) { return nonzero() && legacy != 0L; }
        public synchronized boolean sameLegacy(long legacy) { return comparisonAvailable(legacy) && httpManager == legacy; }
        public String toString() { return "CallbackState[private]"; }
    }
}
