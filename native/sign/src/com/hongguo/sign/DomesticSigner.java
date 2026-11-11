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
public class DomesticSigner extends AbstractJni implements IOResolver<AndroidFileIO> {

    static final String PKG = "com.phoenix.read";
    private String version = "7.4.3.32";
    private int versionCode = 74332;
    private long managerId;      // 对齐设备实际版本(.msp hash 含 versionCode)
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

        // 类链(番茄海外:m ← a4$a ← MS);红果若不同,FindClass 日志会暴露真实名
        DvmClass m = vm.resolveClass("ms/bd/c/m");
        DvmClass a4a = vm.resolveClass("ms/bd/c/a4$a", m);
        vm.resolveClass("com/bytedance/mobsec/metasec/ml/MS", a4a);

        DalvikModule dm = vm.loadLibrary(soMeta, true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);
        System.out.println("[*] JNI_OnLoad 完成 base=0x" + Long.toHexString(module.base));

    }

    private DvmObject<?> handleMS(BaseVM vm, int op) {
        System.out.println("  [MS.b op=" + op + " 0x" + Integer.toHexString(op) + "]");
        switch (op) {
            case 65539:    return new StringObject(vm, FILES + "/.msdata");
            case 33554433:
            case 33554434: return DvmBoolean.valueOf(vm, true);
            case 16777232: return vm.resolveClass("java/lang/Integer").newObject(versionCode); // 红果 versionCode(7.2.5.32)
            case 16777233: return new StringObject(vm, version);
            case 16777218:
                try {
                    if (certFile != null && certFile.exists())
                        return new ByteArray(vm, Files.readAllBytes(certFile.toPath()));
                } catch (Exception e) {}
                System.out.println("    [MS.b op=16777218 证书] 暂无,返回 null");
                return null;
            case 268435470: return vm.resolveClass("java/lang/Long").newObject(2L);
            case 268435471: return vm.resolveClass("java/lang/Long").newObject(0L);
            default:
                System.out.println("    [MS.b 未处理 op=" + op + " 0x" + Integer.toHexString(op) + "]");
                return null;
        }
    }

    @Override
    public DvmObject<?> callStaticObjectMethodV(BaseVM vm, DvmClass c, String sig, VaList va) {
        if (sig.equals("com/bytedance/mobsec/metasec/ml/MS->b(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;"))
            return handleMS(vm, va.getIntArg(0));
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
        if (pathname.startsWith(FILESDIR) || pathname.contains(".ms") || pathname.contains("msdata"))
            System.out.println("  [resolve] " + pathname + " oflags=0x" + Integer.toHexString(oflags));
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



    private DvmObject<?> dispatch(int op, int option, long manager, String value, DvmObject<?> object) {
        return vm.resolveClass("ms/bd/c/m").callStaticJniMethodObject(emulator,
            "a(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;",
            op, option, manager, value==null?null:new StringObject(vm,value), object);
    }

    private void initialize(com.alibaba.fastjson.JSONArray seed, String url) throws Exception {
        java.util.Map<String,String> query=new java.util.HashMap<>();
        String raw=new java.net.URI(url).getRawQuery();
        if(raw!=null)for(String entry:raw.split("&")){
            String[] pair=entry.split("=",2);
            if(pair.length==2)query.put(java.net.URLDecoder.decode(pair[0],"UTF-8"),java.net.URLDecoder.decode(pair[1],"UTF-8"));
        }
        version=query.getOrDefault("version_name",version);
        try{versionCode=Integer.parseInt(query.getOrDefault("version_code",String.valueOf(versionCode)));}catch(NumberFormatException ignored){}
        if(managerId!=0)return;
        com.alibaba.fastjson.JSONArray config=com.alibaba.fastjson.JSON.parseArray(seed.toJSONString());
        config.set(6,query.getOrDefault("device_id",""));
        config.set(8,query.getOrDefault("iid",""));
        config.set(13,query.getOrDefault("device_id",""));
        dispatch(16777219,0,0L,null,vm.resolveClass("android/content/Context").newObject(null));
        DvmObject<?> result=dispatch(67108865,0,0L,config.toJSONString(),null);
        if(result==null||!Boolean.TRUE.equals(result.getValue()))throw new IllegalStateException("Initialization failed");
        DvmObject<?> manager=dispatch(67108866,0,0L,null,null);
        if(manager==null||!(manager.getValue() instanceof Long))throw new IllegalStateException("Initialization failed");
        managerId=(Long)manager.getValue();
    }

    private java.util.Map<String,String> sign(com.alibaba.fastjson.JSONArray seed,String url,byte[] body) throws Exception {
        java.net.URI uri=new java.net.URI(url);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null)throw new IllegalArgumentException("Invalid URL");
        initialize(seed,url);
        DvmObject<?> result=dispatch(33554438,0,managerId,url,body==null?null:new ByteArray(vm,body));
        if(result==null||!(result.getValue() instanceof DvmObject[]))throw new IllegalStateException("Signing failed");
        DvmObject<?>[] pairs=(DvmObject<?>[])result.getValue();
        java.util.Map<String,String> output=new java.util.LinkedHashMap<>();
        java.util.Set<String> allowed=new java.util.HashSet<>(java.util.Arrays.asList("X-Argus","X-Gorgon","X-Helios","X-Khronos","X-Ladon","X-Medusa"));
        for(int i=0;i+1<pairs.length;i+=2){
            String key=String.valueOf(pairs[i].getValue()),value=String.valueOf(pairs[i+1].getValue());
            if(allowed.contains(key)&&!value.isEmpty()&&value.indexOf('\r')<0&&value.indexOf('\n')<0)output.put(key,value);
        }
        if(!output.keySet().containsAll(java.util.Arrays.asList("X-Argus","X-Gorgon","X-Khronos")))throw new IllegalStateException("Signing failed");
        return output;
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
            try {
                DomesticSigner nativeSigner=new DomesticSigner(new File(directory,"libmetasec_ml.so"),new File(directory,"libc++_shared.so"),null);
                byte[] metadata;
                try(java.io.InputStream stream=new java.util.zip.InflaterInputStream(new java.io.FileInputStream(new File(directory,"sdk-metadata.bin")))){metadata=readAll(stream,16384);}
                com.alibaba.fastjson.JSONArray seed=com.alibaba.fastjson.JSON.parseArray(new String(metadata,StandardCharsets.UTF_8));
                if(seed.size()!=17)throw new IllegalStateException("Metadata invalid");
                ready.complete(true);
                while(true){
                    Object[] task=queue.take();
                    @SuppressWarnings("unchecked") java.util.concurrent.CompletableFuture<java.util.Map<String,String>> future=(java.util.concurrent.CompletableFuture<java.util.Map<String,String>>)task[2];
                    try{future.complete(nativeSigner.sign(seed,(String)task[0],(byte[])task[1]));}
                    catch(Throwable ignored){future.completeExceptionally(new IllegalStateException("Signing failed",ignored));}
                }
            } catch(Throwable ignored){ready.completeExceptionally(new IllegalStateException("Signing runtime unavailable"));}
        },"domestic-signer");
        worker.setDaemon(true);worker.start();ready.get(40,java.util.concurrent.TimeUnit.SECONDS);
        com.sun.net.httpserver.HttpServer server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/sign",exchange->{
            byte[] response;int status=200;
            try{
                if(!"POST".equals(exchange.getRequestMethod()))throw new IllegalArgumentException();
                com.alibaba.fastjson.JSONObject request=com.alibaba.fastjson.JSON.parseObject(new String(readAll(exchange.getRequestBody(),131072),StandardCharsets.UTF_8));
                byte[] body=request.containsKey("body_base64")?java.util.Base64.getDecoder().decode(request.getString("body_base64")):null;
                if(body!=null&&body.length>65536)throw new IllegalArgumentException();
                java.util.concurrent.CompletableFuture<java.util.Map<String,String>> future=new java.util.concurrent.CompletableFuture<>();
                if(!queue.offer(new Object[]{request.getString("url"),body,future}))throw new IllegalStateException();
                response=com.alibaba.fastjson.JSON.toJSONBytes(future.get(35,java.util.concurrent.TimeUnit.SECONDS));
            }catch(Throwable ignored){status=503;response="{\"error\":\"Signing unavailable\"}".getBytes(StandardCharsets.UTF_8);}
            exchange.getResponseHeaders().add("Content-Type","application/json");
            exchange.sendResponseHeaders(status,response.length);exchange.getResponseBody().write(response);exchange.close();
        });
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));server.start();
        lifecycle.println("SIGNER_READY 127.0.0.1:"+server.getAddress().getPort());
        Thread.currentThread().join();
    }
    private static byte[] readAll(java.io.InputStream input,int limit) throws java.io.IOException {
        java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] block=new byte[4096];int count;
        while((count=input.read(block))>0){if(output.size()+count>limit)throw new java.io.IOException("Input too large");output.write(block,0,count);}
        return output.toByteArray();
    }
}
