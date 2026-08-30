/**
 * Optional category-specific field config for RST dynamic forms.
 * Tenants keep their own businessCategory in settings — we never force Restaurant
 * onto existing businesses. Default for brand-new setup UIs may prefer Restaurant.
 */

const CATEGORIES = [
  'Barbershop',
  'Hair Salon',
  'Beauty Salon',
  'Nail Salon',
  'Spa / Massage',
  'Skincare / Aesthetic Clinic',
  'Dental Clinic',
  'Medical / Health Clinic',
  'Fitness / Personal Training',
  'Gym / Sports Coaching',
  'Photography Studio',
  'Tattoo Studio',
  'Auto Service / Car Wash',
  'Repair Services',
  'Cleaning Services',
  'Home Services',
  'Tutoring / Education',
  'Consulting / Professional Services',
  'Event Services',
  'Pet Grooming',
  'Restaurant / Food Reservation',
  'Other'
];

const DEFAULT_CATEGORY = 'Restaurant / Food Reservation';

const FORM_CONFIG = {
  'Restaurant / Food Reservation': {
    groupLabel: 'Reservation details',
    fields: [
      { id: 'guests', label: 'Number of guests', type: 'number', required: false, min: 1, max: 50 },
      {
        id: 'tableType',
        label: 'Table type',
        type: 'select',
        required: false,
        options: ['Any Available', 'Indoor', 'Outdoor', 'Private Room', 'VIP']
      }
    ]
  },
  'Barbershop': {
    groupLabel: 'Preferences',
    fields: [{ id: 'preferredStaffNote', label: 'Preferred staff (optional)', type: 'text', required: false }]
  },
  'Hair Salon': {
    groupLabel: 'Preferences',
    fields: [{ id: 'preferredStaffNote', label: 'Preferred stylist (optional)', type: 'text', required: false }]
  },
  'Beauty Salon': {
    groupLabel: 'Preferences',
    fields: [{ id: 'preferredStaffNote', label: 'Preferred staff (optional)', type: 'text', required: false }]
  },
  'Nail Salon': {
    groupLabel: 'Preferences',
    fields: [{ id: 'preferredStaffNote', label: 'Preferred technician (optional)', type: 'text', required: false }]
  },
  'Spa / Massage': {
    groupLabel: 'Preferences',
    fields: [{ id: 'preferredStaffNote', label: 'Preferred therapist (optional)', type: 'text', required: false }]
  },
  'Pet Grooming': {
    groupLabel: 'Pet details',
    fields: [
      { id: 'petType', label: 'Pet type', type: 'select', required: false, options: ['Dog', 'Cat', 'Other'] },
      { id: 'petName', label: 'Pet name (optional)', type: 'text', required: false }
    ]
  },
  'Auto Service / Car Wash': {
    groupLabel: 'Vehicle',
    fields: [
      {
        id: 'vehicleType',
        label: 'Vehicle type',
        type: 'select',
        required: false,
        options: ['Sedan', 'SUV', 'Van', 'Motorcycle', 'Other']
      }
    ]
  },
  'Other': {
    groupLabel: 'Extra details',
    fields: [{ id: 'serviceDescription', label: 'Additional details', type: 'textarea', required: false }]
  }
};

function getFormConfig(category) {
  if (category && FORM_CONFIG[category]) return FORM_CONFIG[category];
  return { groupLabel: 'Extra details', fields: [] };
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORY,
  FORM_CONFIG,
  getFormConfig
};
