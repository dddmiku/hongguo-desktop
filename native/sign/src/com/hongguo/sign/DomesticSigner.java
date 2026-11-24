package com.hongguo.sign;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Emulator;
import com.github.unidbg.Module;
import com.github.unidbg.file.FileResult;
import com.github.unidbg.file.IOResolver;
import com.github.unidbg.file.linux.AndroidFileIO;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.linux.android.dvm.array.ArrayObject;
import com.github.unidbg.linux.android.dvm.array.ByteArray;
import com.github.unidbg.linux.android.dvm.wrapper.DvmBoolean;
import com.github.unidbg.linux.file.SimpleFileIO;
import com.github.unidbg.memory.Memory;
import com.github.unidbg.pointer.UnidbgPointer;
import com.github.unidbg.virtualmodule.android.AndroidModule;
import com.github.unidbg.virtualmodule.android.JniGraphics;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 红果(com.phoenix.read)metasec 脱机签名 —— 移植 zero199901/fqnovel-unidbg(IdleFQ)适配红果。
 * Uses the registered JNI dispatcher and current SDK opcodes; no direct function offsets.
 */
public class DomesticSigner extends AbstractJni implements IOResolver<AndroidFileIO>, AutoCloseable {

    static final String PKG = "com.phoenix.read";
    private String version = "7.4.3.32";
    private int versionCode = 74332;
    private volatile long httpManagerId;
    private volatile boolean httpManagerCallbackSeen;
    private final HttpAbiRuntimeContract.CallbackState httpCallbacks = new HttpAbiRuntimeContract.CallbackState();
    private volatile long managerId;      // 对齐设备实际版本(.msp hash 含 versionCode)
    static final String FILES = "/data/user/0/com.phoenix.read/files";
    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final Memory memory;
    private final File soMeta;
    private File certFile; // op 16777218

    public DomesticSigner(File soMeta, File soCpp, File cert) {
        this.soMeta = soMeta;
        this.certFile = cert;
        emulator = AndroidEmulatorBuilder.for64Bit()
                .setRootDir(new File(System.getProperty("hongguo.sign.data"), "signer-root"))
                .addBackendFactory(new com.github.unidbg.arm.backend.Unicorn2Factory(true))
                .setProcessName(PKG)
                .build();
        emulator.getSyscallHandler().setVerbose(false);
        emulator.getSyscallHandler().addIOResolver(this);
        java.util.Map<String, Integer> inode = new java.util.HashMap<>();
        inode.put("/data/user/0/com.phoenix.read", 655781);
        inode.put("/data/user/0/com.phoenix.read/files", 655864);
        emulator.set("inode", inode);
        emulator.set("uid", 10174);

        memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));

        vm = emulator.createDalvikVM();
        vm.setJni(this);
        vm.setVerbose(false);
        new AndroidModule(emulator, vm).register(memory);
        new JniGraphics(emulator, vm).register(memory);

        if (soCpp != null && soCpp.exists()) vm.loadLibrary(soCpp, false);

        // Current 74332 facade: MS -> q2 -> k3 -> Object; native a is registered on k3.
        DvmClass dispatcher = vm.resolveClass(HttpAbiRuntimeContract.DISPATCHER_CLASS);
        DvmClass facadeParent = vm.resolveClass(HttpAbiRuntimeContract.FACADE_PARENT_CLASS, dispatcher);
        vm.resolveClass(HttpAbiRuntimeContract.FACADE_CLASS, facadeParent);

        DalvikModule dm = vm.loadLibrary(soMeta, true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

    }

    private DvmObject<?> handleMS(BaseVM vm, int op, long callbackLong) {
        switch (op) {
            case 65539:    return new StringObject(vm, FILES + "/.msdata");
            case 33554433:
                httpCallbacks.acceptOpcode(op, callbackLong);
                httpManagerId = callbackLong;
                httpManagerCallbackSeen = true;
                return DvmBoolean.valueOf(vm, true);
            case 33554434: return DvmBoolean.valueOf(vm, true);
            case 16777232: return vm.resolveClass("java/lang/Integer").newObject(versionCode); // 红果 versionCode(7.2.5.32)
            case 16777233: return new StringObject(vm, version);
            case 16777218:
                try {
                    if (certFile != null && certFile.exists())
                        return new ByteArray(vm, Files.readAllBytes(certFile.toPath()));
                } catch (Exception e) {}
                return null;
            case 268435470: return vm.resolveClass("java/lang/Long").newObject(2L);
            case 268435471: return vm.resolveClass("java/lang/Long").newObject(0L);
            default:
                return null;
        }
    }

    @Override
    public DvmObject<?> callStaticObjectMethodV(BaseVM vm, DvmClass c, String sig, VaList va) {
        if (HttpAbiRuntimeContract.isFacadeCallback(sig))
            return handleMS(vm, va.getIntArg(0), va.getLongArg(2));
        if (sig.equals("java/lang/Thread->currentThread()Ljava/lang/Thread;"))
            return vm.resolveClass("java/lang/Thread").newObject(Thread.currentThread());
        if (sig.equals("java/lang/Boolean->valueOf(Z)Ljava/lang/Boolean;"))
            return DvmBoolean.valueOf(vm, va.getIntArg(0) != 0);
        if (sig.equals("java/lang/Integer->valueOf(I)Ljava/lang/Integer;"))
            return vm.resolveClass("java/lang/Integer").newObject(va.getIntArg(0));
        if (sig.equals("java/lang/Long->valueOf(J)Ljava/lang/Long;"))
            return vm.resolveClass("java/lang/Long").newObject(va.getLongArg(0));
        return super.callStaticObjectMethodV(vm, c, sig, va);
    }

    @Override
    public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> o, String sig, VaList va) {
        switch (sig) {
            case "java/lang/Thread->getStackTrace()[Ljava/lang/StackTraceElement;": {
                StackTraceElement[] es = Thread.currentThread().getStackTrace();
                DvmObject[] a = new DvmObject[es.length];
                for (int i = 0; i < es.length; i++) a[i] = vm.resolveClass("java/lang/StackTraceElement").newObject(es[i]);
                return new ArrayObject(a);
            }
            case "java/lang/StackTraceElement->getClassName()Ljava/lang/String;":
                return new StringObject(vm, ((StackTraceElement) o.getValue()).getClassName());
            case "java/lang/StackTraceElement->getMethodName()Ljava/lang/String;":
                return new StringObject(vm, ((StackTraceElement) o.getValue()).getMethodName());
            case "java/lang/Thread->getBytes(Ljava/lang/String;)[B":
                return new ByteArray(vm, ((String) va.getObjectArg(0).getValue()).getBytes(StandardCharsets.UTF_8));
        }
        return super.callObjectMethodV(vm, o, sig, va);
    }

    @Override
    public long callLongMethodV(BaseVM vm, DvmObject<?> o, String sig, VaList va) {
        if ("java/lang/Long->longValue()J".equals(sig) && o.getValue() instanceof Long) return (Long) o.getValue();
        return super.callLongMethodV(vm, o, sig, va);
    }

    @Override
    public int callIntMethodV(BaseVM vm, DvmObject<?> o, String sig, VaList va) {
        if ("java/lang/Integer->intValue()I".equals(sig) && o.getValue() instanceof Integer) return (Integer) o.getValue();
        return super.callIntMethodV(vm, o, sig, va);
    }

    @Override
    public boolean callBooleanMethodV(BaseVM vm, DvmObject<?> o, String sig, VaList va) {
        if ("java/lang/Boolean->booleanValue()Z".equals(sig) && o.getValue() instanceof Boolean) return (Boolean) o.getValue();
        return super.callBooleanMethodV(vm, o, sig, va);
    }

    @Override
    public int getStaticIntField(BaseVM vm, DvmClass c, String sig) {
        if ("com/bytedance/mobsec/metasec/ml/MS->a()V".equals(sig)) return 0x40;
        return super.getStaticIntField(vm, c, sig);
    }

    @Override
    public void callVoidMethod(BaseVM vm, DvmObject<?> o, String sig, VarArg va) {
        if ("com/bytedance/mobsec/metasec/ml/MS->a()V".equals(sig)) return;
        super.callVoidMethod(vm, o, sig, va);
    }

    static final String FILESDIR = "/data/user/0/com.phoenix.read/files";
    static final File MSROOT = new File(System.getProperty("hongguo.sign.data"), "signer-state"); // 含 .msdata/ 真身(从设备拉取)

    @Override
    public FileResult resolve(Emulator emu, String pathname, int oflags) {
        if (pathname.contains("libmetasec_ml.so"))
            return FileResult.success(new SimpleFileIO(oflags, soMeta, pathname));
        // Prototype path diagnostics are intentionally disabled.
        // 映射 metasec 状态目录: /data/.../files/... -> ../capture/msstate/...
        if (pathname.startsWith(FILESDIR)) {
            String rel = pathname.substring(FILESDIR.length());
            File local = new File(MSROOT, rel.replaceFirst("^/+", ""));
            if (local.isDirectory())
                return FileResult.success(new com.github.unidbg.linux.file.DirectoryFileIO(oflags, pathname, local));
            if (local.exists())
                return FileResult.success(new SimpleFileIO(oflags, local, pathname));
            // 不存在: 写/创建(O_CREAT=0x40) 才建文件让 metasec 写新态; 纯读/access 返回未找到
            if ((oflags & 0x40) != 0) {
                local.getParentFile().mkdirs();
                try { local.createNewFile(); } catch (Exception e) {}
                return FileResult.success(new SimpleFileIO(oflags, local, pathname));
            }
            return null;
        }
        return null;
    }



    @Override
    public void callVoidMethodV(BaseVM vm, DvmObject<?> object, String sig, VaList va) {
        if ("ms/bd/c/a3->b(J)V".equals(sig) &&
                "ms/bd/c/h5".equals(object.getObjectType().getClassName())) {
            httpCallbacks.noteExactSetter(sig,object.getObjectType().getClassName());
            return;
        }
        super.callVoidMethodV(vm, object, sig, va);
    }



    private DvmObject<?> dispatch(int op, int option, long manager, String value, DvmObject<?> object) {
        return vm.resolveClass(HttpAbiRuntimeContract.DISPATCHER_CLASS).callStaticJniMethodObject(emulator,
            "a(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;",
            op, option, manager, value==null?null:new StringObject(vm,value), object);
    }

    private void initialize(com.alibaba.fastjson.JSONArray seed, String url) throws Exception {
        java.util.Map<String,String> query=IdentityBoundSignerWorker.identityValues(url);
        com.alibaba.fastjson.JSONArray config=null;
        try {
            if (!String.valueOf(seed.get(0)).equals(query.get("aid")))
                throw new IllegalArgumentException("Invalid signer application");
            version=query.getOrDefault("version_name",version);
            String code=query.get("version_code");
            if (code!=null) {versionCode=Integer.parseInt(code);if(versionCode<=0)throw new IllegalArgumentException();}
            if(managerId!=0)return;
            config=com.alibaba.fastjson.JSON.parseArray(seed.toJSONString());
            config.set(6,query.getOrDefault("device_id",""));
            config.set(8,query.getOrDefault("iid",""));
            config.set(13,query.getOrDefault("device_id",""));
            dispatch(16777219,0,0L,null,vm.resolveClass("android/content/Context").newObject(null));
            DvmObject<?> result=dispatch(67108865,0,0L,config.toJSONString(),null);
            if(result==null||!Boolean.TRUE.equals(result.getValue()))throw new IllegalStateException("Initialization failed");
            DvmObject<?> manager=dispatch(67108866,0,0L,null,null);
            if(manager==null||!(manager.getValue() instanceof Long))throw new IllegalStateException("Initialization failed");
            managerId=(Long)manager.getValue();
        } finally {query.clear();if(config!=null)config.clear();}
    }

    private java.util.Map<String,String> sign(com.alibaba.fastjson.JSONArray seed,HeaderContract.SigningRequest request) throws Exception {
        initialize(seed,request.url());
        if(!httpManagerCallbackSeen||httpManagerId==0L)throw new IllegalStateException("HTTP manager callback unavailable");
        DvmObject<?> result;
        try(HeaderContract.NativeCall call=request.nativeCall(httpManagerId)) {
            String[] nativePairs=call.pairs();
            try {
                result=dispatch(call.opcode(),call.option(),call.httpManager(),call.url(),
                        ArrayObject.newStringArray(vm,nativePairs));
            } finally {java.util.Arrays.fill(nativePairs,null);}
        }
        Object raw=result==null?null:result.getValue();
        String[] strings=null;DvmObject<?>[] objects=null;
        try {
            if(raw instanceof DvmObject[]) {
                objects=(DvmObject<?>[])raw;strings=new String[objects.length];
                for(int i=0;i<objects.length;i++) {
                    Object value=objects[i]==null?null:objects[i].getValue();
                    if(!(value instanceof String))throw new IllegalStateException("Signing failed");
                    strings[i]=(String)value;
                }
                raw=strings;
            }
            try(HttpSignatureResultContract.Inspection inspection=HttpSignatureResultContract.inspect(raw)) {
                return inspection.requireSecurityHeaders();
            }
        } finally {
            if(strings!=null)java.util.Arrays.fill(strings,null);
            if(objects!=null)java.util.Arrays.fill(objects,null);
        }
    }

    public static void main(String[] args) throws Exception {
        final java.io.PrintStream lifecycle=System.out;
        java.io.PrintStream quiet=new java.io.PrintStream(new java.io.OutputStream(){public void write(int value){}});
        System.setOut(quiet);System.setErr(quiet);
        final File directory=new File(args[0]);
        System.setProperty("hongguo.sign.data",args[1]);
        final java.util.concurrent.BlockingQueue<Object[]> queue=new java.util.concurrent.ArrayBlockingQueue<>(128);
        final java.util.concurrent.CompletableFuture<Boolean> ready=new java.util.concurrent.CompletableFuture<>();
        Thread worker=new Thread(()->{
            com.alibaba.fastjson.JSONArray seed=null;
            try {
                byte[] metadata;
                try(java.io.InputStream stream=new java.util.zip.InflaterInputStream(new java.io.FileInputStream(new File(directory,"sdk-metadata.bin")))){metadata=readAll(stream,16384);}
                try {seed=com.alibaba.fastjson.JSON.parseArray(new String(metadata,StandardCharsets.UTF_8));}
                finally {java.util.Arrays.fill(metadata,(byte)0);}
                if(seed.size()!=17)throw new IllegalStateException("Metadata invalid");
                final com.alibaba.fastjson.JSONArray template=seed;
                IdentityBoundSignerWorker contexts=new IdentityBoundSignerWorker(()->new IdentityBoundSignerWorker.Context(){
                    private final DomesticSigner signer=new DomesticSigner(new File(directory,"libmetasec_ml.so"),new File(directory,"libc++_shared.so"),null);
                    private final com.alibaba.fastjson.JSONArray config=com.alibaba.fastjson.JSON.parseArray(template.toJSONString());
                    public java.util.Map<String,String> sign(HeaderContract.SigningRequest request) throws Exception {return signer.sign(config,request);}
                    public void close() throws Exception {try{signer.close();}finally{config.clear();}}
                });
                Runtime.getRuntime().addShutdownHook(new Thread(()->{try{contexts.close();}catch(Throwable ignored){}finally{template.clear();}},"signer-context-cleanup"));
                ready.complete(true);
                try {
                    while(true) {
                        Object[] task=queue.take();
                        @SuppressWarnings("unchecked") java.util.concurrent.CompletableFuture<java.util.Map<String,String>> future=(java.util.concurrent.CompletableFuture<java.util.Map<String,String>>)task[1];
                        HeaderContract.SigningRequest request=(HeaderContract.SigningRequest)task[0];
                        java.util.Map<String,String> output=null;
                        try {
                            if(!future.isCancelled()) {
                                output=contexts.sign(request);
                                if(future.complete(output))output=null;
                            }
                        } catch(IdentityBoundSignerWorker.ContextCloseFailure fatal) {
                            future.completeExceptionally(new IllegalStateException("Signer unavailable"));
                            System.exit(70); // Gateway must see a dead process, not an alive permanently-poisoned signer.
                        } catch(Throwable ignored) {future.completeExceptionally(new IllegalStateException("Signing failed"));}
                        finally {if(output!=null)output.clear();request.close();java.util.Arrays.fill(task,null);}
                    }
                } finally {contexts.close();}
            } catch(Throwable ignored) {ready.completeExceptionally(new IllegalStateException("Startup failed"));}
            finally {if(seed!=null)seed.clear();}
        },"hongguo-sdk");
        worker.setDaemon(true);worker.start();ready.get(40,java.util.concurrent.TimeUnit.SECONDS);
        com.sun.net.httpserver.HttpServer server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/sign",exchange->{
            byte[] response=null;int status=200;HeaderContract.SigningRequest request=null;
            java.util.concurrent.CompletableFuture<java.util.Map<String,String>> future=null;
            try {
                if(!"POST".equals(exchange.getRequestMethod()))throw new IllegalArgumentException();
                byte[] privateRaw=readAll(exchange.getRequestBody(),HeaderContract.MAX_REQUEST_BYTES);
                try {request=HeaderContract.parseRequest(privateRaw);}
                finally {java.util.Arrays.fill(privateRaw,(byte)0);}
                future=new java.util.concurrent.CompletableFuture<>();
                if(!queue.offer(new Object[]{request,future}))throw new IllegalStateException();
                request=null;
                java.util.Map<String,String> output=future.get(35,java.util.concurrent.TimeUnit.SECONDS);
                try {response=com.alibaba.fastjson.JSON.toJSONBytes(output);}finally{output.clear();}
            } catch(Throwable ignored) {
                if(future!=null && !future.cancel(false) && !future.isCompletedExceptionally()) {
                    java.util.Map<String,String> abandoned=future.getNow(null);
                    if(abandoned!=null)abandoned.clear();
                }
                status=503;response="{\"error\":\"Signing failed\"}".getBytes(StandardCharsets.UTF_8);
            }
            finally {if(request!=null)request.close();}
            try {
                exchange.getResponseHeaders().add("Content-Type","application/json");
                exchange.sendResponseHeaders(status,response.length);exchange.getResponseBody().write(response);
            } finally {if(response!=null)java.util.Arrays.fill(response,(byte)0);exchange.close();}
        });
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));server.start();
        lifecycle.println("SIGNER_READY 127.0.0.1:"+server.getAddress().getPort());
        Thread.currentThread().join();
    }
    public void close() throws java.io.IOException {
        managerId=0L;httpManagerId=0L;httpManagerCallbackSeen=false;httpCallbacks.reset();
        emulator.close();
    }

    private static byte[] readAll(java.io.InputStream input,int limit) throws java.io.IOException {
        java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] block=new byte[4096];int count;
        while((count=input.read(block))>0){if(output.size()+count>limit)throw new java.io.IOException("Input too large");output.write(block,0,count);}
        return output.toByteArray();
    }
}
