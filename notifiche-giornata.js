/*
  Giornata · invio automatico delle notifiche
  Lo lancia GitHub Actions ogni 10 minuti (file .github/workflows/notifiche.yml).
  Legge impegni e promemoria da Firestore e manda le notifiche push ai dispositivi attivati nell'app.
  Non contiene password: la chiave di Firebase arriva dal secret FIREBASE_SERVICE_ACCOUNT di GitHub.
*/
const admin = require("firebase-admin");

const TZ = "Europe/Rome";
const APP_URL = (process.env.APP_URL || "https://davidelodi18.github.io/calendar/").replace(/\/?$/, "/");
const TICK = 10;          // minuti tra un controllo e l'altro (come nel workflow)
const MAX_LEAD = 60;      // anticipo massimo selezionabile nell'app
const DEFAULTS = { startAlerts: true, leadMin: 15, digest: true, digestTime: "07:30" };

let sa;
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); } catch (e) { sa = null; }
if (!sa || !sa.project_id) {
  console.error("Manca il secret FIREBASE_SERVICE_ACCOUNT (oppure non contiene il JSON completo della chiave).");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

/* ---- date in ora italiana ---- */
const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hm = (d) => new Intl.DateTimeFormat("it-IT", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const longDay = (d) => { const s = new Intl.DateTimeFormat("it-IT", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(d); return s.charAt(0).toUpperCase() + s.slice(1); };

/* ---- stesse regole dell'app ---- */
const isDone = (e) => !!e.done || e.status === "done";
const showInPlanner = (e) => (e.inPlanner === undefined || e.inPlanner === null) ? (e.inGantt !== false) : (e.inPlanner !== false);
const inBoard = (e) => e.inGantt !== false || showInPlanner(e);
const overlapsDay = (e, k) => dayKey(new Date(e.start)) <= k && dayKey(new Date(new Date(e.end).getTime() - 1)) >= k;
const list = (arr, n = 3) => arr.slice(0, n).join(", ") + (arr.length > n ? ` (+${arr.length - n})` : "");

async function logged(id) { return (await db.collection("pushLog").doc(id).get()).exists; }
async function mark(id, uid, now) { await db.collection("pushLog").doc(id).set({ uid, at: now.getTime() }); }

async function send(tokens, { title, body, tag }) {
  const msgs = tokens.map((t) => ({
    token: t.token,
    notification: { title, body },
    data: { url: APP_URL, tag: tag || "" },
    webpush: {
      notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png", ...(tag ? { tag } : {}) },
      fcmOptions: { link: APP_URL },
    },
  }));
  const res = await admin.messaging().sendEach(msgs);
  let ok = 0;
  for (let i = 0; i < res.responses.length; i++) {
    const r = res.responses[i];
    if (r.success) { ok++; continue; }
    const code = r.error && r.error.code;
    console.warn(`  invio non riuscito a ${tokens[i].device || "dispositivo"}: ${code}`);
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      await db.collection("pushTokens").doc(tokens[i].id).delete();   // dispositivo scollegato: lo tolgo
    }
  }
  console.log(`  "${title}" → ${ok}/${tokens.length} dispositivi`);
  return ok;
}

async function runUser(uid, tokens, now, windowEvents) {
  const sref = db.collection("pushSettings").doc(uid);
  const snap = await sref.get();
  const s = { ...DEFAULTS, ...(snap.exists ? snap.data() : {}) };
  const busSnap = await db.collection("bus").where("uid", "==", uid).get();
  const buName = {}; busSnap.forEach((d) => { buName[d.id] = d.data().name; });

  /* 1. prova richiesta dall'app */
  if (s.testPending) {
    await send(tokens, { title: "Giornata ✅", body: "Prova riuscita: le notifiche automatiche funzionano.", tag: "prova" });
    await sref.set({ testPending: false }, { merge: true });
  }

  /* 2. avviso prima degli impegni */
  if (s.startAlerts) {
    const lead = Math.min(MAX_LEAD, Math.max(0, Number(s.leadMin) || 15));
    for (const ev of windowEvents) {
      if (ev.uid !== uid || isDone(ev) || ev.inCalendar === false || ev.notify === false) continue;
      const start = new Date(ev.start), end = new Date(ev.end);
      // mando quando mancano "lead" minuti (con mezzo giro di tolleranza, così non arriva in ritardo)
      if (start.getTime() - lead * 60000 > now.getTime() + (TICK / 2) * 60000) continue;
      const id = `start_${ev.id}_${start.getTime()}`;
      if (await logged(id)) continue;
      const left = Math.round((start - now) / 60000);
      const when = left <= 1 ? "Inizia ora" : left < 60 ? `Fra ${left} min` : `Fra ${Math.floor(left / 60)} h${left % 60 ? " " + (left % 60) + " min" : ""}`;
      const bu = ev.buId && buName[ev.buId] ? ` · ${buName[ev.buId]}` : "";
      await send(tokens, { title: `⏰ ${ev.title || "Impegno"}`, body: `${when} · ${hm(start)}–${hm(end)}${bu}`, tag: `ev-${ev.id}` });
      await mark(id, uid, now);
    }
  }

  /* 3. riepilogo del mattino */
  if (s.digest) {
    const today = dayKey(now);
    const nowMin = toMin(hm(now)), dMin = toMin(s.digestTime || "07:30");
    const id = `digest_${uid}_${today}`;
    if (nowMin >= dMin && nowMin <= dMin + 180 && !(await logged(id))) {
      const evSnap = await db.collection("events").where("uid", "==", uid).get();
      const events = evSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.start && e.end);
      const remSnap = await db.collection("reminders").where("uid", "==", uid).get();
      const reminders = remSnap.docs.map((d) => d.data());

      const byStart = (a, b) => new Date(a.start) - new Date(b.start);
      const todayCal = events.filter((e) => e.inCalendar !== false && !isDone(e) && overlapsDay(e, today)).sort(byStart);
      const first = todayCal.find((e) => dayKey(new Date(e.start)) === today);
      const top3 = events.filter((e) => e.priorityLevel === "top3" && !isDone(e) && overlapsDay(e, today))
        .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999) || byStart(a, b));
      const late = events.filter((e) => inBoard(e) && !isDone(e) && dayKey(new Date(e.end)) < today);
      const rem = reminders.filter((r) => !r.done && r.due && r.due <= today);

      const lines = [];
      lines.push(todayCal.length
        ? `📅 ${todayCal.length} impegn${todayCal.length === 1 ? "o" : "i"}${first ? ` · il primo alle ${hm(new Date(first.start))} (${first.title})` : ""}`
        : "📅 Nessun impegno in calendario");
      if (top3.length) lines.push(`🎯 Top 3: ${list(top3.map((e) => e.title))}`);
      if (late.length) lines.push(`⚠️ ${late.length} in ritardo`);
      if (rem.length) lines.push(`🔔 Promemoria: ${list(rem.map((r) => r.text))}`);

      await send(tokens, { title: `Buongiorno! ${longDay(now)}`, body: lines.join("\n"), tag: "riepilogo" });
      await mark(id, uid, now);
    }
  }

  await sref.set({ lastRun: now.getTime(), lastError: admin.firestore.FieldValue.delete() }, { merge: true });
}

async function main() {
  const now = new Date();
  console.log(`Controllo delle ${hm(now)} (${dayKey(now)})`);

  const tokSnap = await db.collection("pushTokens").get();
  const byUid = {};
  tokSnap.forEach((d) => { const t = d.data(); if (t.uid && t.token) (byUid[t.uid] = byUid[t.uid] || []).push({ id: d.id, token: t.token, device: t.device }); });
  const uids = Object.keys(byUid);
  console.log(`Dispositivi attivi: ${tokSnap.size}`);
  if (!uids.length) return;

  // impegni che iniziano da 2 minuti fa fino a (anticipo massimo + mezzo giro) da adesso
  const from = new Date(now.getTime() - 2 * 60000).toISOString();
  const to = new Date(now.getTime() + (MAX_LEAD + TICK) * 60000).toISOString();
  const winSnap = await db.collection("events").where("start", ">=", from).where("start", "<=", to).get();
  const windowEvents = winSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  for (const uid of uids) {
    try { await runUser(uid, byUid[uid], now, windowEvents); }
    catch (e) {
      console.error(`Errore per ${uid}:`, e);
      await db.collection("pushSettings").doc(uid).set({ lastRun: now.getTime(), lastError: String(e.message || e).slice(0, 300) }, { merge: true }).catch(() => {});
    }
  }

  // pulizia: tolgo il registro degli invii più vecchio di 14 giorni
  const old = await db.collection("pushLog").where("at", "<", now.getTime() - 14 * 86400000).limit(300).get();
  if (!old.empty) { const b = db.batch(); old.forEach((d) => b.delete(d.ref)); await b.commit(); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
