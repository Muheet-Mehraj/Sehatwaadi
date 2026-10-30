// Used only when the Hub's /api/catalog/home can't be reached, so the category tiles still show and still search.
// The Hub is the source of truth for the live shelves (see deliveryRoutes.js, CATEGORIES).
export const FALLBACK_CATEGORIES = [
  { key: 'pain-fever', name: 'Pain & Fever', icon: '🌡️', color: '#FFE9E3', q: 'paracetamol' },
  { key: 'cold-cough', name: 'Cold & Cough', icon: '🤧', color: '#E7F1FF', q: 'cough' },
  { key: 'digestive', name: 'Digestive Care', icon: '🍃', color: '#E9F7EC', q: 'antacid' },
  { key: 'vitamins', name: 'Vitamins', icon: '🌿', color: '#FFF6D9', q: 'vitamin' },
  { key: 'skin', name: 'Skin & Hair', icon: '🧴', color: '#FDE8F3', q: 'cream' },
  { key: 'first-aid', name: 'First Aid', icon: '🩹', color: '#FFECEC', q: 'bandage' },
  { key: 'diabetes', name: 'Diabetes Care', icon: '🩸', color: '#EAEAFE', q: 'glucose' },
  { key: 'devices', name: 'Health Devices', icon: '🩺', color: '#E3F6F8', q: 'thermometer' },
  { key: 'baby', name: 'Baby & Mom', icon: '🍼', color: '#FFF0E0', q: 'baby' },
  { key: 'herbal', name: 'Kashmiri Herbal', icon: '🏔️', color: '#EFF7E4', q: 'himalaya' },
];
