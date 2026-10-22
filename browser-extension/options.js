const DEFAULTS = {
  capture: true,
  extensions:
    'zip rar 7z tar gz tgz bz2 xz zst iso cab img exe msi msix msixbundle appx apk jar dmg deb rpm ' +
    'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts 3gp mp3 m4a flac wav aac ogg opus wma pdf epub ' +
    'doc docx xls xlsx ppt pptx odt ods odp psd ai dwg bin dat vhd vhdx ova ovf torrent',
  minSizeMb: 20,
  allTypes: false,
};
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS).catch(() => ({}))) };
  $('capture').checked = s.capture;
  $('extensions').value = s.extensions;
  $('minSizeMb').value = s.minSizeMb;
  $('allTypes').checked = s.allTypes;
}

let timer;
function save() {
  const s = {
    capture: $('capture').checked,
    extensions: $('extensions').value.trim(),
    minSizeMb: Math.max(0, Number($('minSizeMb').value) || 0),
    allTypes: $('allTypes').checked,
  };
  chrome.storage.sync.set(s).then(() => {
    $('saved').textContent = 'Saved.';
    clearTimeout(timer);
    timer = setTimeout(() => ($('saved').textContent = ''), 1500);
  });
}

for (const id of ['capture', 'extensions', 'minSizeMb', 'allTypes']) $(id).addEventListener('change', save);

chrome.runtime.sendMessage({ type: 'ping' }, (reply) => {
  const el = $('status');
  if (reply && reply.ok) {
    el.textContent = `Haul ${reply.version} is reachable on this PC.`;
    el.className = 'status ok';
  } else {
    el.textContent = 'Haul cannot be reached. Install Haul and open it once, so it registers itself for the browser; until then downloads stay with the browser.';
    el.className = 'status bad';
  }
});

void load();
