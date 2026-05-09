const fs = require('fs');
const path = require('path');

// Indicatifs pays avec drapeaux et noms
const COUNTRY_CODES = [
  { code: '509', name: 'Haïti', flag: '🇭🇹' },
  { code: '1829', name: 'Rép. Dominicaine', flag: '🇩🇴' },
  { code: '1809', name: 'Rép. Dominicaine', flag: '🇩🇴' },
  { code: '1849', name: 'Rép. Dominicaine', flag: '🇩🇴' },
  { code: '1', name: 'USA / Canada', flag: '🇺🇸' },
  { code: '243', name: 'RD Congo', flag: '🇨🇩' },
  { code: '242', name: 'Congo', flag: '🇨🇬' },
  { code: '237', name: 'Cameroun', flag: '🇨🇲' },
  { code: '225', name: "Côte d'Ivoire", flag: '🇨🇮' },
  { code: '229', name: 'Bénin', flag: '🇧🇯' },
  { code: '224', name: 'Guinée', flag: '🇬🇳' },
  { code: '223', name: 'Mali', flag: '🇲🇱' },
  { code: '221', name: 'Sénégal', flag: '🇸🇳' },
  { code: '228', name: 'Togo', flag: '🇹🇬' },
  { code: '226', name: 'Burkina Faso', flag: '🇧🇫' },
  { code: '235', name: 'Tchad', flag: '🇹🇩' },
  { code: '227', name: 'Niger', flag: '🇳🇪' },
  { code: '233', name: 'Ghana', flag: '🇬🇭' },
  { code: '234', name: 'Nigéria', flag: '🇳🇬' },
  { code: '254', name: 'Kenya', flag: '🇰🇪' },
  { code: '27', name: 'Afrique du Sud', flag: '🇿🇦' },
  { code: '263', name: 'Zimbabwe', flag: '🇿🇼' },
  { code: '252', name: 'Somalie', flag: '🇸🇴' },
  { code: '241', name: 'Gabon', flag: '🇬🇦' },
  { code: '55', name: 'Brésil', flag: '🇧🇷' },
  { code: '57', name: 'Colombie', flag: '🇨🇴' },
  { code: '92', name: 'Pakistan', flag: '🇵🇰' },
  { code: '93', name: 'Afghanistan', flag: '🇦🇫' },
  { code: '94', name: 'Sri Lanka', flag: '🇱🇰' },
  { code: '213', name: 'Algérie', flag: '🇩🇿' },
  { code: '212', name: 'Maroc', flag: '🇲🇦' },
  { code: '216', name: 'Tunisie', flag: '🇹🇳' },
  { code: '33', name: 'France', flag: '🇫🇷' },
  { code: '32', name: 'Belgique', flag: '🇧🇪' },
  { code: '41', name: 'Suisse', flag: '🇨🇭' },
];

function getCountry(number) {
  // Trier par longueur décroissante pour matcher le plus long d'abord
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);
  for (const country of sorted) {
    if (number.startsWith(country.code)) {
      return country;
    }
  }
  return { code: number.slice(0, 3), name: 'Inconnu', flag: '🌍' };
}

function getActiveSessions() {
  const sessionDir = path.join(__dirname, 'session');
  if (!fs.existsSync(sessionDir)) return new Set();
  const files = fs.readdirSync(sessionDir);
  const active = new Set();
  for (const f of files) {
    const match = f.match(/^creds_(\d+)\.json$/);
    if (match) active.add(match[1]);
  }
  return active;
}

function loadAllNumbers() {
  const numbersPath = path.join(__dirname, 'session', 'numbers.json');
  const numbersPath2 = path.join(__dirname, 'numbers.json');
  let numbers = [];
  if (fs.existsSync(numbersPath)) {
    try { numbers = JSON.parse(fs.readFileSync(numbersPath, 'utf8')); } catch(e) {}
  }
  if (fs.existsSync(numbersPath2)) {
    try {
      const n2 = JSON.parse(fs.readFileSync(numbersPath2, 'utf8'));
      numbers = [...new Set([...numbers, ...n2])];
    } catch(e) {}
  }
  return numbers;
}

function pad(str, len) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function displayStats() {
  console.clear();

  const activeSessions = getActiveSessions();
  const allNumbers = loadAllNumbers();
  const totalAll = allNumbers.length;
  const totalActive = activeSessions.size;

  // Compter par pays
  const countryCounts = {};
  for (const num of allNumbers) {
    const country = getCountry(num);
    const key = country.code;
    if (!countryCounts[key]) {
      countryCounts[key] = { ...country, total: 0, active: 0 };
    }
    countryCounts[key].total++;
    if (activeSessions.has(num)) {
      countryCounts[key].active++;
    }
  }

  // Trier par total décroissant
  const sorted = Object.values(countryCounts).sort((a, b) => b.total - a.total).slice(0, 10);

  const line = '═'.repeat(62);
  const thin = '─'.repeat(62);

  console.log('\n╔' + line + '╗');
  console.log('║' + ' '.repeat(15) + '📊  STATS BOT WHATSAPP' + ' '.repeat(24) + '║');
  console.log('╠' + line + '╣');
  console.log(`║  🌐 Total numéros enregistrés : ${pad(totalAll, 5)}                       ║`);
  console.log(`║  ✅ Sessions actives (fichiers): ${pad(totalActive, 5)}                       ║`);
  console.log('╠' + line + '╣');
  console.log('║  ' + pad('RANG', 6) + pad('PAYS', 22) + pad('INDICATIF', 12) + pad('TOTAL', 8) + pad('ACTIFS', 7) + '║');
  console.log('╠' + line + '╣');

  sorted.forEach((c, i) => {
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1} `;
    const flag = c.flag;
    const name = pad(c.name, 18);
    const indic = pad('+' + c.code, 12);
    const total = pad(c.total, 8);
    const active = pad(c.active > 0 ? '✅ ' + c.active : '—', 7);
    console.log(`║  ${pad(rank, 4)} ${flag} ${name} ${indic} ${total} ${active}║`);
  });

  console.log('╚' + line + '╝');
  console.log(`\n  🕐 Mis à jour : ${new Date().toLocaleString('fr-FR')}`);
  console.log('  ↻  Refresh auto toutes les 30 secondes...\n');
}

// Affichage initial + refresh auto
displayStats();
setInterval(displayStats, 30000);
