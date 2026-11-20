// Prepares android/app/build.gradle for a SIGNED release build (used by .github/workflows/build-apk.yml).
// Reads KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD / VERSION_CODE / VERSION_NAME from the environment.
import fs from 'fs';
const p = process.argv[2] || 'android/app/build.gradle';
let g = fs.readFileSync(p, 'utf8');
if (!g.includes('ONDA_SIGNING')) {
  const signing = `
    // ONDA_SIGNING
    signingConfigs {
        release {
            storeFile file(System.getenv('KEYSTORE_FILE'))
            storePassword System.getenv('KEYSTORE_PASSWORD')
            keyAlias System.getenv('KEY_ALIAS')
            keyPassword System.getenv('KEY_PASSWORD')
        }
    }
`;
  const bt = g.search(/\n\s*buildTypes\s*\{/);
  if (bt < 0) throw new Error('buildTypes block not found in ' + p);
  const rel = g.slice(bt).search(/\n\s*release\s*\{/);
  if (rel < 0) throw new Error('release block not found in ' + p);
  const at = bt + rel;
  const head = g.slice(0, at), tail = g.slice(at).replace(/(\n\s*)release\s*\{/, '$1release {$1    signingConfig signingConfigs.release');
  g = (head + tail).replace(/\n(\s*)buildTypes\s*\{/, signing + '\n$1buildTypes {');
}
const vc = process.env.VERSION_CODE, vn = process.env.VERSION_NAME;
if (vc) g = g.replace(/versionCode\s*=?\s*\d+/, 'versionCode ' + parseInt(vc, 10));
if (vn) g = g.replace(/versionName\s*=?\s*"[^"]*"/, 'versionName "' + vn + '"');
fs.writeFileSync(p, g);
console.log('release signing ready:', p);
