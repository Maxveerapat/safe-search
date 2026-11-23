package app.safesearch.shield;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;

/**
 * Live check, from this phone's own connection: does the site's real server answer over HTTPS?
 *   SAFE     – a secure connection to the real server succeeded (a block page can't fake its certificate)
 *   NOTSAFE  – no secure connection: blocked, redirected to a block page, down, or no answer
 * Every site gets a verdict within 3 s (shown as Not safe if still unanswered, then corrected if it answers later).
 */
final class SiteChecker {
    enum State { CHECKING, SAFE, NOTSAFE }

    static final class Entry {
        volatile State state = State.CHECKING;
        volatile boolean provisional;
        volatile String how = "checking";
        volatile long checkedAt;
        volatile long ms;
    }

    private static final long SLA_MS = 3000;
    private static final long CACHE_MS = 15 * 60 * 1000;
    private static final int FIRST_TIMEOUT = 6000, RETRY_TIMEOUT = 4000;

    private final ConcurrentHashMap<String, Entry> map = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(16);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable onChange;

    SiteChecker(Runnable onChange) { this.onChange = onChange; }

    Entry get(String domain) {
        Entry e = map.get(domain);
        long now = System.currentTimeMillis();
        if (e != null && (e.state == State.CHECKING || e.provisional || now - e.checkedAt < CACHE_MS)) return e;
        return start(domain);
    }

    Entry peek(String domain) { return map.get(domain); }

    private Entry start(String domain) {
        final Entry e = new Entry();
        map.put(domain, e);
        main.postDelayed(() -> {
            if (e.state == State.CHECKING) {
                e.state = State.NOTSAFE;
                e.provisional = true;
                e.how = "No answer within 3 s, shown as Not safe for now (still checking)";
                onChange.run();
            }
        }, SLA_MS);
        pool.submit(() -> {
            long t0 = SystemClock.elapsedRealtime();
            String r = probe(domain, FIRST_TIMEOUT);
            if (r != null) {
                SystemClock.sleep(300);
                r = probe(domain, RETRY_TIMEOUT);
            }
            final String failure = r;
            final long took = SystemClock.elapsedRealtime() - t0;
            main.post(() -> {
                e.state = failure == null ? State.SAFE : State.NOTSAFE;
                e.provisional = false;
                e.how = failure == null ? "Connected securely to the site's real server" : failure;
                e.ms = took;
                e.checkedAt = System.currentTimeMillis();
                onChange.run();
            });
        });
        return e;
    }

    /** @return null if the real server answered over HTTPS, otherwise a short reason. */
    private static String probe(String domain, int timeout) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("https://" + domain + "/robots.txt").openConnection();
            if (!(c instanceof HttpsURLConnection)) return "not a secure connection";
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(timeout);
            c.setReadTimeout(timeout);
            c.setUseCaches(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36");
            c.getResponseCode(); // any HTTP answer (200, 301, 403, 404…) proves the real server is reachable
            return null;
        } catch (UnknownHostException ex) {
            return "Site address not found (blocked or doesn't exist)";
        } catch (SSLException ex) {
            return "Secure connection failed (typical of a block page)";
        } catch (SocketTimeoutException ex) {
            return "No answer (blocked or not responding)";
        } catch (Exception ex) {
            return "Couldn't connect: " + ex.getClass().getSimpleName();
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
