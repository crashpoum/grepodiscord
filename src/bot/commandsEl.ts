/**
 * Greek (el) localization for every slash command, subcommand, option and choice.
 * Keys: "cmd", "cmd/sub", "cmd/sub/option", "cmd/option", choices "…/option=value".
 * "*\/option" and "*\/option=value" are fallbacks shared by all commands (world, page, kind …).
 * Value: [name, description] (choices: [name]). Discord rules: names lowercase, ≤32 chars, no spaces.
 */
import type { RESTPostAPIChatInputApplicationCommandsJSONBody as CmdJson, APIApplicationCommandOption as Opt } from 'discord.js';

export const EL: Record<string, [string, string?]> = {
  // shared options
  '*/world': ['κόσμος', 'Κόσμος, π.χ. gr125 ή en180 (προεπιλογή: κόσμος του server)'],
  '*/page': ['σελίδα', 'Σελίδα (προεπιλογή 1)'],
  '*/kind': ['είδος', 'Παίκτες ή συμμαχίες (προεπιλογή: παίκτες)'],
  '*/kind=player': ['παίκτες'],
  '*/kind=alliance': ['συμμαχίες'],
  '*/player': ['παίκτης', 'Παίκτης'],
  '*/alliance': ['συμμαχία', 'Συμμαχία'],
  '*/town': ['πόλη', 'Πόλη'],
  '*/filter': ['φίλτρο', 'Ποιες κατακτήσεις (προεπιλογή: όλες)'],
  '*/filter=all': ['όλες'],
  '*/filter=enemy': ['εχθρικές'],
  '*/filter=friendly': ['φιλικές'],
  '*/filter=internal': ['εσωτερικές'],
  '*/ocean': ['ωκεανός', 'Ωκεανός/οί, π.χ. 45 ή 45,46'],
  '*/near_town': ['κοντά_σε_πόλη', 'Ταξινόμηση κατά απόσταση από αυτή την πόλη'],
  '*/radius': ['ακτίνα', 'Μέγιστη απόσταση από την πόλη (προεπιλογή 20)'],
  '*/role': ['ρόλος', 'Ρόλος'],

  help: ['βοήθεια', 'Τι μπορεί να κάνει το bot'],

  setup: ['ρυθμίσεις', 'Ρυθμίσεις server (διαχειριστές)'],
  'setup/world': ['κόσμος', 'Ορισμός προεπιλεγμένου κόσμου'],
  'setup/world/world': ['κόσμος', 'Κόσμος, π.χ. gr125'],
  'setup/language': ['γλώσσα', 'Γλώσσα του bot για τον server'],
  'setup/language/language': ['γλώσσα', 'Γλώσσα'],
  'setup/language/language=en': ['English'],
  'setup/language/language=el': ['Ελληνικά'],
  'setup/show': ['εμφάνιση', 'Εμφάνιση ρυθμίσεων'],

  player: ['παίκτης', 'Στατιστικά και γράφημα παίκτη'],
  'player/name': ['όνομα', 'Όνομα παίκτη'],
  alliance: ['συμμαχία', 'Στατιστικά και γράφημα συμμαχίας'],
  'alliance/name': ['όνομα', 'Όνομα συμμαχίας'],

  radar: ['ραντάρ', 'Εύρεση ανενεργών παικτών και πόλεων-φαντασμάτων'],
  'radar/inactive': ['ανενεργοί', 'Παίκτες χωρίς ανάπτυξη/πόντους μάχης για Ν ώρες'],
  'radar/inactive/hours': ['ώρες', 'Ώρες αδράνειας (προεπιλογή 48)'],
  'radar/inactive/min_points': ['ελάχιστοι_πόντοι', 'Ελάχιστοι πόντοι παίκτη'],
  'radar/ghosts': ['φαντάσματα', 'Πόλεις-φαντάσματα (χωρίς ιδιοκτήτη)'],
  'radar/ghosts/min_points': ['ελάχιστοι_πόντοι', 'Ελάχιστοι πόντοι πόλης'],

  feed: ['ροή', 'Αυτόματες ροές (διαχειριστές)'],
  'feed/add': ['προσθήκη', 'Δημοσίευση ροής σε κανάλι μετά από κάθε ωριαία ενημέρωση'],
  'feed/add/type': ['τύπος', 'Τύπος ροής'],
  'feed/add/type=conquests': ['Κατακτήσεις'],
  'feed/add/type=alliance': ['Είσοδοι/αποχωρήσεις συμμαχιών'],
  'feed/add/type=bp': ['Άλματα πόντων μάχης'],
  'feed/add/channel': ['κανάλι', 'Κανάλι προορισμού'],
  'feed/add/alliance': ['συμμαχία', 'Μόνο γεγονότα με αυτή τη συμμαχία'],
  'feed/add/player': ['παίκτης', 'Μόνο γεγονότα με αυτόν τον παίκτη'],
  'feed/add/ocean': ['ωκεανός', 'Κατακτήσεις: μόνο σε αυτούς τους ωκεανούς, π.χ. 45,46'],
  'feed/add/min_bp': ['ελάχιστοι_πμ', 'Ροή πόντων μάχης: ελάχιστη αύξηση ανά ενημέρωση (προεπιλογή 5000)'],
  'feed/add/bp_kind': ['είδος_πμ', 'Ροή πόντων μάχης: επίθεση, άμυνα ή και τα δύο'],
  'feed/add/bp_kind=any': ['και τα δύο'],
  'feed/add/bp_kind=att': ['επίθεση'],
  'feed/add/bp_kind=def': ['άμυνα'],
  'feed/add/skip_ghosts': ['χωρίς_φαντάσματα', 'Κατακτήσεις: αγνόησε πόλεις-φαντάσματα'],
  'feed/list': ['λίστα', 'Λίστα ροών'],
  'feed/remove': ['αφαίρεση', 'Αφαίρεση ροής'],
  'feed/remove/id': ['αριθμός', 'Αριθμός ροής'],

  verify: ['επαλήθευση', 'Σύνδεση του Discord σου με τον παίκτη σου'],
  'verify/start': ['έναρξη', 'Πάρε έναν κωδικό για να τον βάλεις στο όνομα μιας πόλης σου'],
  'verify/start/player': ['παίκτης', 'Το όνομα του παίκτη σου στο παιχνίδι'],
  'verify/check': ['έλεγχος', 'Έλεγξε τον κωδικό σου τώρα'],
  'verify/status': ['κατάσταση', 'Εμφάνιση της σύνδεσής σου'],
  'verify/unlink': ['αποσύνδεση', 'Αφαίρεση της σύνδεσής σου'],

  roles: ['ρόλοι', 'Αυτόματοι ρόλοι από συμμαχία (διαχειριστές)'],
  'roles/verified': ['επαληθευμένοι', 'Ρόλος για κάθε επαληθευμένο μέλος'],
  'roles/alliance': ['συμμαχία', 'Ρόλος για τα επαληθευμένα μέλη μιας συμμαχίας'],
  'roles/remove': ['αφαίρεση', 'Αφαίρεση αντιστοίχισης ρόλου συμμαχίας'],
  'roles/list': ['λίστα', 'Εμφάνιση αντιστοιχίσεων ρόλων'],
  'roles/sync': ['συγχρονισμός', 'Συγχρονισμός ρόλων τώρα'],

  top: ['κορυφαίοι', 'Κατατάξεις και ημερήσιοι/ωριαίοι πίνακες'],
  'top/today': ['σήμερα', 'Κορυφαίοι σε επίθεση, άμυνα, κατακτήσεις και απώλειες σήμερα'],
  'top/yesterday': ['χθες', 'Ο πίνακας της χθεσινής μέρας'],
  'top/hour': ['ώρα', 'Οι περισσότεροι πόντοι μάχης σε μία ώρα (παίκτες)'],
  'top/hour/hour': ['ώρα', 'Ώρα σήμερα, ώρα κόσμου 0-23 (προεπιλογή: η τελευταία πλήρης ώρα)'],
  'top/ranking': ['κατάταξη', 'Γενική κατάταξη'],
  'top/ranking/sort': ['ταξινόμηση', 'Ταξινόμηση κατά (προεπιλογή: πόντοι)'],
  'top/ranking/sort=Points': ['πόντοι'],
  'top/ranking/sort=Att': ['πόντοι επίθεσης'],
  'top/ranking/sort=Def': ['πόντοι άμυνας'],
  'top/ranking/sort=AttDef': ['σύνολο πόντων μάχης'],
  'top/ranking/sort=Towns': ['πόλεις'],
  'top/ranking/sort=Members': ['μέλη (συμμαχίες)'],

  wars: ['πόλεμοι', 'Από ποιους πήρε και σε ποιους έχασε πόλεις μια συμμαχία'],

  changes: ['αλλαγές', 'Ιστορικό εισόδων/αποχωρήσεων συμμαχιών'],
  'changes/alliance': ['συμμαχία', 'Μέλη που μπήκαν ή έφυγαν από μια συμμαχία'],
  'changes/player': ['παίκτης', 'Συμμαχίες στις οποίες ήταν ένας παίκτης'],
  'changes/world': ['κόσμος', 'Πρόσφατες αλλαγές συμμαχιών σε όλο τον κόσμο'],

  conquests: ['κατακτήσεις', 'Ιστορικό κατακτήσεων'],
  'conquests/player': ['παίκτης', 'Πόλεις που πήρε ή έχασε ένας παίκτης'],
  'conquests/alliance': ['συμμαχία', 'Πόλεις που πήρε ή έχασε μια συμμαχία'],
  'conquests/town': ['πόλη', 'Όλες οι αλλαγές ιδιοκτήτη μιας πόλης'],

  town: ['πόλη', 'Πόλεις: αναζήτηση, στοιχεία και ραντάρ'],
  'town/search': ['αναζήτηση', 'Αναζήτηση πόλεων με όνομα'],
  'town/search/query': ['κείμενο', 'Μέρος του ονόματος της πόλης'],
  'town/info': ['στοιχεία', 'Ιδιοκτήτης, πόντοι και νησί μιας πόλης'],
  'town/radar': ['ραντάρ', 'Πόλεις γύρω από μια πόλη ή συντεταγμένες νησιού'],
  'town/radar/town': ['πόλη', 'Πόλη στο κέντρο'],
  'town/radar/x': ['x', 'Νησί x (μαζί με y, αντί για πόλη)'],
  'town/radar/y': ['y', 'Νησί y (μαζί με x, αντί για πόλη)'],
  'town/radar/radius': ['ακτίνα', 'Ακτίνα σε νησιά (προεπιλογή 15, μέγιστο 150)'],
  'town/radar/ghosts_only': ['μόνο_φαντάσματα', 'Μόνο πόλεις-φαντάσματα'],

  intel: ['πληροφορίες', 'Πληροφορίες City Indexer από το GrepoData (ευρετήρια αυτού του server)'],
  'intel/town': ['πόλη', 'Τελευταίες αναφορές για μια πόλη'],
  'intel/player': ['παίκτης', 'Πόλεις και στρατεύματα ενός παίκτη στα ευρετήρια'],
  'intel/alliance': ['συμμαχία', 'Πόλεις και στρατεύματα μιας συμμαχίας στα ευρετήρια'],

  grepodata: ['grepodata', 'Λογαριασμός GrepoData για πληροφορίες (διαχειριστές, ιδιωτικές απαντήσεις)'],
  'grepodata/token': ['token', 'Ορισμός token GrepoData για αυτόν τον server (ιδιωτική απάντηση)'],
  'grepodata/token/access_token': ['access_token', 'Το access_token από το grepodata.com (Local Storage του browser)'],
  'grepodata/token/refresh_token': ['refresh_token', 'Το refresh_token: το bot ανανεώνει μόνο του το token (προτείνεται)'],
  'grepodata/status': ['κατάσταση', 'Λήξη token, αυτόματη ανανέωση και κανάλι πληροφοριών'],
  'grepodata/channel': ['κανάλι', 'Κανάλι όπου οι πληροφορίες εμφανίζονται δημόσια (κενό: παντού ιδιωτικά)'],
  'grepodata/channel/channel': ['κανάλι', 'Κανάλι (άφησέ το κενό για ιδιωτικές πληροφορίες παντού)'],
  'grepodata/clear': ['διαγραφή', 'Αφαίρεση του token GrepoData από αυτόν τον server'],
};

/** Look up a localization: exact path first, then the shared "*\/option[=value]" fallback. */
export function elFor(path: string[], leaf: string): [string, string?] | undefined {
  return EL[[...path, leaf].join('/')] ?? (path.length ? EL[`*/${leaf}`] : undefined);
}

type Node = { name: string; description?: string; name_localizations?: Record<string, string> | null; description_localizations?: Record<string, string> | null; options?: Opt[] };

/** Apply Greek names/descriptions to command JSON (returns new objects; missing entries are left as-is and caught by tests). */
export function localizeCommands(cmds: CmdJson[]): CmdJson[] {
  const walk = (node: Node, path: string[]): Node => {
    const l = elFor(path, node.name);
    const out: Node = { ...node };
    if (l) {
      out.name_localizations = { ...(node.name_localizations ?? {}), el: l[0] };
      if (l[1]) out.description_localizations = { ...(node.description_localizations ?? {}), el: l[1] };
    }
    const here = [...path, node.name];
    if (node.options) {
      out.options = node.options.map((o) => {
        const lo = walk(o as Node, here) as unknown as Opt & { choices?: { name: string; value: string | number; name_localizations?: Record<string, string> }[] };
        if (lo.choices) {
          lo.choices = lo.choices.map((c) => {
            const hit = EL[[...here, `${o.name}=${c.value}`].join('/')] ?? EL[`*/${o.name}=${c.value}`];
            return hit ? { ...c, name_localizations: { ...(c.name_localizations ?? {}), el: hit[0] } } : c;
          });
        }
        return lo;
      });
    }
    return out;
  };
  return cmds.map((c) => walk(c as unknown as Node, []) as unknown as CmdJson);
}
