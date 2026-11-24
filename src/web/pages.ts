/** Small server-rendered pages: terms, privacy (both bilingual EN/GR), messages and the server picker. */
import { t, type Lang } from '../i18n.js';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shell(title: string, body: string, lang: Lang = 'en') {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css"></head><body class="page"><main class="doc">${body}</main></body></html>`;
}

/** Message page. The "Sign in with Discord" link only appears when Discord login is configured; otherwise it says how to get a fresh link. */
export function messagePage(lang: Lang, msg: string, opts: { login?: boolean; hint?: boolean } = {}) {
  const tail = opts.login
    ? `<p><a class="btn" href="/login">${esc(t(lang, 'web.loginLink'))}</a></p>`
    : opts.hint ? `<p>${esc(t(lang, 'web.freshLink'))}</p>` : '';
  return shell('GrepoCord', `<h1>GrepoCord</h1><p>${esc(msg)}</p>${tail}`, lang);
}

export function pickerPage(lang: Lang, guilds: { id: string; name: string; href: string }[]) {
  const items = guilds.map((g) => `<li><a class="btn" href="${esc(g.href)}">${esc(g.name)}</a></li>`).join('');
  return shell('GrepoCord', `<h1>${esc(t(lang, 'web.pick'))}</h1><ul class="picker">${items}</ul>`, lang);
}

export function termsPage(contact: string) {
  const c = contact ? esc(contact) : 'the server administrators / οι διαχειριστές του διακομιστή';
  return shell('GrepoCord — Terms', `
<h1>Terms of Service</h1>
<p>GrepoCord Live is a free, unofficial companion for the browser game Grepolis, run by a Discord community for its own members. It is provided "as is", without warranty. It is not affiliated with InnoGames or GrepoData.</p>
<p>You may use it only if you are a member of a Discord server where the GrepoCord bot is installed. Do not share personal links: they give access to your server's view. Do not try to break, overload or scrape the service. Access can be removed at any time.</p>
<p>Contact: ${c}</p>
<h1>Όροι χρήσης</h1>
<p>Το GrepoCord Live είναι δωρεάν, ανεπίσημο βοήθημα για το παιχνίδι Grepolis, που λειτουργεί μια κοινότητα Discord για τα μέλη της. Παρέχεται «ως έχει», χωρίς καμία εγγύηση. Δεν συνδέεται με την InnoGames ή το GrepoData.</p>
<p>Μπορείς να το χρησιμοποιείς μόνο αν είσαι μέλος διακομιστή Discord όπου είναι εγκατεστημένο το GrepoCord. Μη μοιράζεσαι τους προσωπικούς συνδέσμους. Μην προσπαθείς να παραβιάσεις ή να υπερφορτώσεις την υπηρεσία. Η πρόσβαση μπορεί να αφαιρεθεί οποτεδήποτε.</p>
<p>Επικοινωνία: ${c}</p>`);
}

export function privacyPage(contact: string) {
  const c = contact ? esc(contact) : 'the server administrators / οι διαχειριστές του διακομιστή';
  return shell('GrepoCord — Privacy', `
<h1>Privacy Policy</h1>
<p>When you sign in with Discord we receive your Discord user id, name and the list of servers you are in, only to check that you belong to a server that uses GrepoCord. The Discord access token is used once and is not stored. We store nothing about you beyond what the GrepoCord bot already keeps for your server (for example a linked Grepolis player).</p>
<p>Game data shown comes from the public Grepolis world files and from GrepoData, using the server's own GrepoData account. Sessions are signed tokens kept in your browser tab and expire after 12 hours. Error logs may contain technical details (time, page, error) and are rotated by the host. Nothing is sold or shared with third parties. Traffic is served through Cloudflare.</p>
<p>Contact / deletion requests: ${c}</p>
<h1>Πολιτική απορρήτου</h1>
<p>Όταν συνδέεσαι με Discord λαμβάνουμε το αναγνωριστικό χρήστη, το όνομα και τη λίστα διακομιστών σου, μόνο για να ελέγξουμε ότι ανήκεις σε διακομιστή που χρησιμοποιεί το GrepoCord. Το διακριτικό πρόσβασης του Discord χρησιμοποιείται μία φορά και δεν αποθηκεύεται. Δεν κρατάμε τίποτα για σένα πέρα από όσα ήδη κρατά το GrepoCord για τον διακομιστή σου (π.χ. συνδεδεμένο παίκτη).</p>
<p>Τα δεδομένα παιχνιδιού προέρχονται από τα δημόσια αρχεία κόσμων του Grepolis και από το GrepoData, με τον λογαριασμό GrepoData του διακομιστή. Οι συνεδρίες είναι υπογεγραμμένα διακριτικά στην καρτέλα του φυλλομετρητή σου και λήγουν σε 12 ώρες. Τα αρχεία σφαλμάτων μπορεί να περιέχουν τεχνικές λεπτομέρειες (ώρα, σελίδα, σφάλμα) και ανακυκλώνονται από τον διακομιστή. Τίποτα δεν πωλείται ούτε μοιράζεται με τρίτους. Η κίνηση περνά μέσω Cloudflare.</p>
<p>Επικοινωνία / αιτήματα διαγραφής: ${c}</p>`);
}
