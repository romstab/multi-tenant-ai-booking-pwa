/**
 * BookAI — Philippine address helpers (Batch 7)
 * Geographic data source: public PSGC API (https://psgc.gitlab.io/api/)
 * Free, no API key. Requires network. Not a government verification of street addresses.
 */

const PSGC_BASE = 'https://psgc.gitlab.io/api';

async function psgcFetch(path) {
  const url = PSGC_BASE + path;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Location data unavailable (' + res.status + ')');
  return res.json();
}

export async function loadRegions() {
  const list = await psgcFetch('/regions/');
  return (list || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function loadProvinces(regionCode) {
  if (!regionCode) return [];
  const list = await psgcFetch('/regions/' + encodeURIComponent(regionCode) + '/provinces/');
  return (list || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Cities under a province, or under a region when the region has no provinces (e.g. NCR). */
export async function loadCities(regionCode, provinceCode) {
  if (provinceCode) {
    const list = await psgcFetch('/provinces/' + encodeURIComponent(provinceCode) + '/cities-municipalities/');
    return (list || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  if (regionCode) {
    const list = await psgcFetch('/regions/' + encodeURIComponent(regionCode) + '/cities-municipalities/');
    return (list || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return [];
}

export async function loadBarangays(cityCode) {
  if (!cityCode) return [];
  const list = await psgcFetch('/cities-municipalities/' + encodeURIComponent(cityCode) + '/barangays/');
  return (list || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [];
  if (loc.specificAddress) parts.push(loc.specificAddress);
  if (loc.barangay && loc.barangay.name) parts.push('Brgy. ' + loc.barangay.name);
  const cityProv = [loc.cityMunicipality?.name, loc.province?.name].filter(Boolean).join(', ');
  if (cityProv) parts.push(cityProv);
  if (loc.region && loc.region.name) parts.push(loc.region.name);
  parts.push(loc.country || 'Philippines');
  return parts.join(', ');
}

/** Prefer structured location; fall back to legacy plain-text address. */
export function displayAddress(settings) {
  if (!settings) return '';
  if (settings.location && (settings.location.barangay || settings.location.cityMunicipality || settings.location.specificAddress)) {
    return formatLocation(settings.location);
  }
  return String(settings.address || '').trim();
}

export function mapsSearchUrl(settings) {
  const q = displayAddress(settings);
  if (!q) return '';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

function fillSelect(sel, items, placeholder, selectedCode) {
  if (!sel) return;
  const prev = selectedCode || '';
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = placeholder;
  sel.appendChild(opt0);
  (items || []).forEach((item) => {
    const o = document.createElement('option');
    o.value = item.code;
    o.textContent = item.name;
    o.dataset.name = item.name;
    if (item.code === prev) o.selected = true;
    sel.appendChild(o);
  });
  sel.disabled = false;
}

function selectedItem(sel) {
  if (!sel || !sel.value) return null;
  const opt = sel.selectedOptions[0];
  return { code: sel.value, name: opt?.dataset?.name || opt?.textContent || '' };
}

/**
 * Wire cascading selects under a container.
 * Expected element ids (prefix):
 *  {prefix}-region, {prefix}-province, {prefix}-city, {prefix}-barangay,
 *  {prefix}-specific, {prefix}-status, {prefix}-province-wrap
 */
export function mountPhAddressForm(prefix, initialLocation) {
  const regionSel = document.getElementById(prefix + '-region');
  const provinceSel = document.getElementById(prefix + '-province');
  const citySel = document.getElementById(prefix + '-city');
  const brgySel = document.getElementById(prefix + '-barangay');
  const specificEl = document.getElementById(prefix + '-specific');
  const statusEl = document.getElementById(prefix + '-status');
  const provinceWrap = document.getElementById(prefix + '-province-wrap');

  if (!regionSel || !citySel || !brgySel) {
    console.warn('ph-address: missing selects for', prefix);
    return null;
  }

  let regionsCache = [];
  let noProvinceMode = false;

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  async function init() {
    setStatus('Loading regions…');
    regionSel.disabled = true;
    try {
      regionsCache = await loadRegions();
      fillSelect(regionSel, regionsCache, 'Select region', initialLocation?.region?.code);
      setStatus('');
      if (initialLocation?.region?.code) {
        await onRegionChange(true);
      }
    } catch (e) {
      console.error(e);
      setStatus('Could not load Philippine location list. Check internet and try again.', true);
      regionSel.disabled = false;
    }
  }

  async function onRegionChange(fromInit) {
    const region = selectedItem(regionSel);
    fillSelect(provinceSel, [], 'Select province', '');
    fillSelect(citySel, [], 'Select city / municipality', '');
    fillSelect(brgySel, [], 'Select barangay', '');
    if (!region) {
      if (provinceWrap) provinceWrap.classList.remove('hidden');
      provinceSel.disabled = true;
      citySel.disabled = true;
      brgySel.disabled = true;
      return;
    }
    setStatus('Loading provinces…');
    try {
      const provinces = await loadProvinces(region.code);
      noProvinceMode = !provinces.length;
      if (noProvinceMode) {
        if (provinceWrap) provinceWrap.classList.add('hidden');
        fillSelect(provinceSel, [], '—', '');
        provinceSel.disabled = true;
        setStatus('Loading cities…');
        const cities = await loadCities(region.code, null);
        fillSelect(
          citySel,
          cities,
          'Select city / municipality',
          fromInit ? initialLocation?.cityMunicipality?.code : ''
        );
        citySel.disabled = false;
        brgySel.disabled = true;
        setStatus('');
        if (fromInit && initialLocation?.cityMunicipality?.code) await onCityChange(true);
      } else {
        if (provinceWrap) provinceWrap.classList.remove('hidden');
        fillSelect(
          provinceSel,
          provinces,
          'Select province',
          fromInit ? initialLocation?.province?.code : ''
        );
        provinceSel.disabled = false;
        citySel.disabled = true;
        brgySel.disabled = true;
        setStatus('');
        if (fromInit && initialLocation?.province?.code) await onProvinceChange(true);
      }
    } catch (e) {
      console.error(e);
      setStatus('Failed to load provinces/cities. Try again.', true);
    }
  }

  async function onProvinceChange(fromInit) {
    const region = selectedItem(regionSel);
    const province = selectedItem(provinceSel);
    fillSelect(citySel, [], 'Select city / municipality', '');
    fillSelect(brgySel, [], 'Select barangay', '');
    if (!province && !noProvinceMode) {
      citySel.disabled = true;
      brgySel.disabled = true;
      return;
    }
    setStatus('Loading cities…');
    try {
      const cities = await loadCities(region?.code, province?.code || null);
      fillSelect(
        citySel,
        cities,
        'Select city / municipality',
        fromInit ? initialLocation?.cityMunicipality?.code : ''
      );
      citySel.disabled = false;
      brgySel.disabled = true;
      setStatus('');
      if (fromInit && initialLocation?.cityMunicipality?.code) await onCityChange(true);
    } catch (e) {
      console.error(e);
      setStatus('Failed to load cities. Try again.', true);
    }
  }

  async function onCityChange(fromInit) {
    const city = selectedItem(citySel);
    fillSelect(brgySel, [], 'Select barangay', '');
    if (!city) {
      brgySel.disabled = true;
      return;
    }
    setStatus('Loading barangays…');
    try {
      const brgys = await loadBarangays(city.code);
      fillSelect(
        brgySel,
        brgys,
        'Select barangay',
        fromInit ? initialLocation?.barangay?.code : ''
      );
      brgySel.disabled = false;
      setStatus('');
    } catch (e) {
      console.error(e);
      setStatus('Failed to load barangays. Try again.', true);
    }
  }

  regionSel.addEventListener('change', () => onRegionChange(false));
  if (provinceSel) provinceSel.addEventListener('change', () => onProvinceChange(false));
  citySel.addEventListener('change', () => onCityChange(false));

  if (specificEl && initialLocation?.specificAddress) {
    specificEl.value = initialLocation.specificAddress;
  }

  init();

  return {
    getValue() {
      const region = selectedItem(regionSel);
      const province = noProvinceMode ? null : selectedItem(provinceSel);
      const city = selectedItem(citySel);
      const barangay = selectedItem(brgySel);
      const specificAddress = (specificEl?.value || '').trim();
      const location = {
        country: 'Philippines',
        region,
        province,
        cityMunicipality: city,
        barangay,
        specificAddress,
        // Reserved for a future real pin — never fabricate
        coordinates: null
      };
      location.formatted = formatLocation(location);
      return location;
    },
    validate() {
      const region = selectedItem(regionSel);
      if (!region) return { ok: false, message: 'Select a Region.' };
      if (!noProvinceMode && !selectedItem(provinceSel)) {
        return { ok: false, message: 'Select a Province.' };
      }
      if (!selectedItem(citySel)) return { ok: false, message: 'Select a City / Municipality.' };
      if (!selectedItem(brgySel)) return { ok: false, message: 'Select a Barangay.' };
      return { ok: true };
    },
    setStatus
  };
}
