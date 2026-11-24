package com.hongguo.sign;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** CPU-only request/header contract. No native library, HTTP client or diagnostic values. */
public final class HeaderContract {
    public static final int HTTP_SECURITY_OPCODE = 50331649;
    public static final int HTTP_SECURITY_OPTION = 0;
    public static final int MAX_REQUEST_BYTES = 131072;
    public static final int MAX_BODY_BYTES = 65536;
    public static final int MAX_HEADER_COUNT = 128;
    public static final int MAX_HEADER_BYTES = 65536;
    private static final int MAX_NAME_CHARS = 256;
    private static final int MAX_VALUE_CHARS = 8192;
    private static final String INVALID_HEADER = "Invalid header contract";
    private static final String INVALID_REQUEST = "Invalid signing request";
    private static final Set<String> OLD_SECURITY = new HashSet<String>(Arrays.asList(
            "x-argus", "x-gorgon", "x-helios", "x-khronos", "x-ladon", "x-medusa"));

    private HeaderContract() {}

    public static HeaderBlock validate(Map<?, ?> source, byte[] body) {
        if (source == null || source.size() > MAX_HEADER_COUNT ||
                (body != null && body.length > MAX_BODY_BYTES)) throw headerError();
        Set<String> names = new HashSet<String>();
        String[] pairs = new String[source.size() * 2];
        int used = 0;
        int byteCount = 0;
        String stub = null;
        try {
            for (Map.Entry<?, ?> entry : source.entrySet()) {
                if (!(entry.getKey() instanceof String) || !(entry.getValue() instanceof String))
                    throw headerError();
                String name = (String) entry.getKey();
                String value = (String) entry.getValue();
                if (!validName(name) || value.length() > MAX_VALUE_CHARS || !validValue(value))
                    throw headerError();
                String canonical = name.toLowerCase(Locale.ROOT);
                if (!names.add(canonical)) throw headerError();
                byteCount += utf8Bytes(name) + utf8Bytes(value) + 4;
                if (byteCount > MAX_HEADER_BYTES) throw headerError();
                if ("x-ss-stub".equals(canonical)) stub = value;
                if (!OLD_SECURITY.contains(canonical)) {
                    pairs[used++] = name;
                    pairs[used++] = value;
                }
            }
            if (body == null) {
                // Existing PC GET contract has no body and no fabricated payload digest.
                if (stub != null) throw headerError();
            } else {
                if (stub == null || !isHexDigest(stub) || !stub.equalsIgnoreCase(md5Hex(body)))
                    throw headerError();
            }
            return new HeaderBlock(Arrays.copyOf(pairs, used));
        } finally {
            Arrays.fill(pairs, null);
            names.clear();
        }
    }

    public static SigningRequest fromValues(String url, Map<?, ?> headers, byte[] body) {
        validateUrl(url);
        return new SigningRequest(url, validate(headers, body), body == null ? null : body.clone());
    }

    public static SigningRequest parseRequest(byte[] raw) {
        if (raw == null || raw.length == 0 || raw.length > MAX_REQUEST_BYTES) throw requestError();
        final String json;
        try {
            json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(raw)).toString();
        } catch (CharacterCodingException ignored) {
            throw requestError();
        }
        return new RequestParser(json).parse();
    }

    private static boolean validName(String name) {
        if (name.length() == 0 || name.length() > MAX_NAME_CHARS) return false;
        final String punctuation = "!#$%&'*+-.^_`|~";
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || punctuation.indexOf(c) >= 0)) return false;
        }
        return true;
    }

    private static boolean validValue(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c) || c == 0x2028 || c == 0x2029) return false;
            if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) return false;
            } else if (Character.isLowSurrogate(c)) return false;
        }
        return true;
    }

    private static int utf8Bytes(String value) {
        try {
            return StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(value)).remaining();
        } catch (CharacterCodingException ignored) {
            throw headerError();
        }
    }

    private static boolean isHexDigest(String value) {
        if (value.length() != 32) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')))
                return false;
        }
        return true;
    }

    private static String md5Hex(byte[] body) {
        try {
            byte[] digest = MessageDigest.getInstance("MD5").digest(body);
            char[] output = new char[digest.length * 2];
            final char[] hex = "0123456789ABCDEF".toCharArray();
            for (int i = 0; i < digest.length; i++) {
                output[i * 2] = hex[(digest[i] >>> 4) & 15];
                output[i * 2 + 1] = hex[digest[i] & 15];
            }
            Arrays.fill(digest, (byte) 0);
            return new String(output);
        } catch (java.security.NoSuchAlgorithmException ignored) {
            throw headerError();
        }
    }

    private static void validateUrl(String url) {
        if (url == null || url.length() == 0 || url.length() > 8192 || !validValue(url)) throw requestError();
        try {
            URI uri = new URI(url);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null)
                throw requestError();
        } catch (java.net.URISyntaxException ignored) {
            throw requestError();
        }
    }

    private static IllegalArgumentException headerError() { return new IllegalArgumentException(INVALID_HEADER); }
    private static IllegalArgumentException requestError() { return new IllegalArgumentException(INVALID_REQUEST); }

    public static final class HeaderBlock implements AutoCloseable {
        private String[] pairs;
        private HeaderBlock(String[] pairs) { this.pairs = pairs; }
        public synchronized String[] flattenedPairs() {
            if (pairs == null) throw headerError();
            return pairs.clone();
        }
        public synchronized int pairCount() {
            if (pairs == null) throw headerError();
            return pairs.length / 2;
        }
        private synchronized ComparisonInputs comparisonInputs() {
            if(pairs==null)throw headerError();
            String stub=null,contentType=null;
            for(int i=0;i<pairs.length;i+=2) {
                if("x-ss-stub".equalsIgnoreCase(pairs[i]))stub=pairs[i+1];
                if("content-type".equalsIgnoreCase(pairs[i]))contentType=pairs[i+1];
            }
            return new ComparisonInputs(stub,contentType);
        }
        public synchronized void close() {
            if (pairs != null) Arrays.fill(pairs, null);
            pairs = null;
        }
        public String toString() { return "HeaderBlock[private]"; }
    }

    public static final class SigningRequest implements AutoCloseable {
        private String url;
        private HeaderBlock headers;
        private byte[] body;
        private SigningRequest(String url, HeaderBlock headers, byte[] body) {
            this.url = url; this.headers = headers; this.body = body;
        }
        public synchronized String url() {
            if (headers == null) throw requestError();
            return url;
        }
        public synchronized NativeCall nativeCall(long httpManager) {
            if (headers == null) throw requestError();
            return new NativeCall(url, httpManager, headers.flattenedPairs());
        }
        public synchronized ComparisonInputs comparisonInputs() {
            if(headers==null)throw requestError();
            return headers.comparisonInputs();
        }
        public synchronized void close() {
            if (body != null) Arrays.fill(body, (byte) 0);
            body = null;
            if (headers != null) headers.close();
            headers = null; url = null;
        }
        public String toString() { return "SigningRequest[private]"; }
    }
    public static final class ComparisonInputs implements AutoCloseable {
        private String stub;
        private String contentType;
        private ComparisonInputs(String stub,String contentType){this.stub=stub;this.contentType=contentType;}
        public String stubForRamComparison(){return stub;}
        public String contentTypeForRamComparison(){return contentType;}
        public void close(){stub=null;contentType=null;}
        public String toString(){return "ComparisonInputs[private]";}
    }

    /** Production prototype supplies the independent native-to-Java HTTP manager callback. */
    public static final class NativeCall implements AutoCloseable {
        private String url;
        private final long manager;
        private String[] pairs;
        private NativeCall(String url, long manager, String[] pairs) {
            this.url = url; this.manager = manager; this.pairs = pairs;
        }
        public int opcode() { return HTTP_SECURITY_OPCODE; }
        public int option() { return HTTP_SECURITY_OPTION; }
        public long httpManager() { return manager; }
        public String handleSource() { return "http-manager-callback-required"; }
        public synchronized String url() { if (pairs == null) throw requestError(); return url; }
        public synchronized String[] pairs() { if (pairs == null) throw requestError(); return pairs.clone(); }
        public boolean rawBodyForwarded() { return false; }
        public synchronized void close() {
            if (pairs != null) Arrays.fill(pairs, null);
            pairs = null; url = null;
        }
        public String toString() { return "NativeCall[private]"; }
    }

    /** Strict small JSON grammar prevents duplicate controls from disappearing in JSONObject. */
    private static final class RequestParser {
        private final String json;
        private int offset;
        private RequestParser(String json) { this.json = json; }
        private SigningRequest parse() {
            String url = null;
            String bodyBase64 = null;
            Map<String, String> headers = null;
            Set<String> fields = new HashSet<String>();
            byte[] decodedBody = null;
            try {
                take('{');
                if (!peek('}')) {
                    while (true) {
                        String key = string(32);
                        if (!fields.add(key) || fields.size() > 3) throw requestError();
                        take(':');
                        if ("url".equals(key)) url = string(8192);
                        else if ("headers".equals(key)) headers = headers();
                        else if ("body_base64".equals(key)) bodyBase64 = string(87384);
                        else throw requestError();
                        if (peek('}')) break;
                        take(',');
                    }
                }
                take('}'); space();
                if (offset != json.length() || url == null || headers == null) throw requestError();
                if (bodyBase64 != null) {
                    try { decodedBody = Base64.getDecoder().decode(bodyBase64); }
                    catch (IllegalArgumentException ignored) { throw requestError(); }
                    if (decodedBody.length > MAX_BODY_BYTES) throw requestError();
                }
                return fromValues(url, headers, decodedBody);
            } finally {
                if (decodedBody != null) Arrays.fill(decodedBody, (byte) 0);
                if (headers != null) headers.clear();
                fields.clear();
            }
        }
        private Map<String, String> headers() {
            Map<String, String> result = new LinkedHashMap<String, String>();
            try {
                take('{');
                if (!peek('}')) {
                    while (true) {
                        String name = string(MAX_NAME_CHARS);
                        if (result.containsKey(name) || result.size() >= MAX_HEADER_COUNT) throw headerError();
                        take(':');
                        result.put(name, string(MAX_VALUE_CHARS));
                        if (peek('}')) break;
                        take(',');
                    }
                }
                take('}');
                return result;
            } catch (RuntimeException ignored) {
                result.clear(); throw headerError();
            }
        }
        private String string(int maxChars) {
            space();
            if (offset >= json.length() || json.charAt(offset++) != '"') throw requestError();
            StringBuilder output = new StringBuilder();
            while (offset < json.length()) {
                char c = json.charAt(offset++);
                if (c == '"') return output.toString();
                if (c < 0x20) throw requestError();
                if (c == '\\') {
                    if (offset >= json.length()) throw requestError();
                    char escaped = json.charAt(offset++);
                    switch (escaped) {
                        case '"': c = '"'; break;
                        case '\\': c = '\\'; break;
                        case '/': c = '/'; break;
                        case 'b': c = '\b'; break;
                        case 'f': c = '\f'; break;
                        case 'n': c = '\n'; break;
                        case 'r': c = '\r'; break;
                        case 't': c = '\t'; break;
                        case 'u':
                            if (offset + 4 > json.length()) throw requestError();
                            int number = 0;
                            for (int i = 0; i < 4; i++) {
                                char character = json.charAt(offset++);
                                int digit;
                                if (character >= '0' && character <= '9') digit = character - '0';
                                else if (character >= 'a' && character <= 'f') digit = character - 'a' + 10;
                                else if (character >= 'A' && character <= 'F') digit = character - 'A' + 10;
                                else throw requestError();
                                number = number * 16 + digit;
                            }
                            c = (char) number; break;
                        default: throw requestError();
                    }
                }
                output.append(c);
                if (output.length() > maxChars) throw requestError();
            }
            throw requestError();
        }
        private void space() {
            while (offset < json.length()) {
                char c = json.charAt(offset);
                if (c != ' ' && c != '\t' && c != '\r' && c != '\n') return;
                offset++;
            }
        }
        private boolean peek(char expected) { space(); return offset < json.length() && json.charAt(offset) == expected; }
        private void take(char expected) {
            space();
            if (offset >= json.length() || json.charAt(offset++) != expected) throw requestError();
        }
    }
}
