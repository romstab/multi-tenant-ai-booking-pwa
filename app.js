/**
 * Core Application Helpers
 * Multi-Tenant AI Booking & Service Scheduler
 * -------------------------------------------
 * Time utilities, slot generation, conflict detection,
 * and shared helpers used by dashboard and booking pages.
 */

/**
 * Convert "HH:MM" → minutes since midnight
 */
export function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Convert minutes since midnight → "HH:MM"
 */
export function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Get weekday key from a date string (YYYY-MM-DD)
 */
export function getWeekdayKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[d.getDay()];
}

/**
 * Check if two time ranges overlap
 * Conflict when: requestedStart < existingEnd AND requestedEnd > existingStart
 */
export function hasScheduleConflict(reqStart, reqEnd, existStart, existEnd) {
  return reqStart < existEnd && reqEnd > existStart;
}

/**
 * Generate available time slots for a given date
 * @param {Object} options
 * @param {string} options.date - YYYY-MM-DD
 * @param {number} options.durationMinutes - service duration
 * @param {Object} options.operatingHours - from settings
 * @param {Array} options.existingAppointments - array of {startTime, endTime, date}
 * @param {number} [options.slotInterval=30] - minutes between slot starts
 */
export function generateAvailableSlots({
  date,
  durationMinutes,
  operatingHours,
  existingAppointments = [],
  slotInterval = 30
}) {
  const weekday = getWeekdayKey(date);
  const dayConfig = operatingHours?.[weekday];

  if (!dayConfig || !dayConfig.enabled || !dayConfig.open || !dayConfig.close) {
    return [];
  }

  const openMin = timeToMinutes(dayConfig.open);
  const closeMin = timeToMinutes(dayConfig.close);

  if (closeMin <= openMin) return [];

  const slots = [];
  const appointmentsOnDay = existingAppointments.filter(a => a.date === date);

  for (let start = openMin; start + durationMinutes <= closeMin; start += slotInterval) {
    const end = start + durationMinutes;
    let conflict = false;

    for (const appt of appointmentsOnDay) {
      const existStart = timeToMinutes(appt.startTime);
      const existEnd = timeToMinutes(appt.endTime);
      if (hasScheduleConflict(start, end, existStart, existEnd)) {
        conflict = true;
        break;
      }
    }

    if (!conflict) {
      slots.push({
        startTime: minutesToTime(start),
        endTime: minutesToTime(end)
      });
    }
  }

  return slots;
}

/**
 * Format a date for display
 */
export function formatDisplayDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

/**
 * Simple toast / message helper (optional visual feedback)
 */
export function showMessage(elementId, text, type = 'error') {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden', 'text-red-600', 'text-green-600', 'text-sky-600');
  if (type === 'success') el.classList.add('text-green-600');
  else if (type === 'info') el.classList.add('text-sky-600');
  else el.classList.add('text-red-600');
  el.classList.remove('hidden');
}

/**
 * Copy text to clipboard with fallback
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / insecure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      document.body.removeChild(ta);
      return false;
    }
  }
}

/**
 * Default operating hours template
 */
export function getDefaultOperatingHours() {
  return {
    monday:    { enabled: true,  open: '09:00', close: '17:00' },
    tuesday:   { enabled: true,  open: '09:00', close: '17:00' },
    wednesday: { enabled: true,  open: '09:00', close: '17:00' },
    thursday:  { enabled: true,  open: '09:00', close: '17:00' },
    friday:    { enabled: true,  open: '09:00', close: '17:00' },
    saturday:  { enabled: true,  open: '10:00', close: '15:00' },
    sunday:    { enabled: false, open: '',      close: '' }
  };
}

export function formatMoney(amount, currency) {
  const n = Number(amount);
  if (Number.isNaN(n)) return '—';
  const c = (currency || 'PHP').toUpperCase();
  const symbols = { PHP: '₱', USD: '$', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', SGD: 'S$', AUD: 'A$' };
  const sym = symbols[c] || (c + ' ');
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
  } catch (e) {
    return sym + n.toLocaleString();
  }
}

export function formatTime12(hhmm) {
  if (!hhmm) return '';
  const p = String(hhmm).split(':');
  let h = parseInt(p[0], 10);
  const m = p[1] || '00';
  if (Number.isNaN(h)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return h + ':' + m + ' ' + ampm;
}
