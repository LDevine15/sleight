// Shared facts for the three hand-off tasks (bench/fowl/handoff.json). The graders and the local
// site both read these, so a number in the PDF is the same number the grader looks for.

export const INVOICE_TOTAL = '1,247.50';
export const INVOICE_ID = 'INV-4419';

export const ROSTER = [
  { name: 'Mira Hale', role: 'Editor', hours: '12.5' },
  { name: 'Jonah Whitfield', role: 'Illustrator', hours: '8.0' },
  { name: 'Aiko Brennan', role: 'Producer', hours: '20.0' },
];

export const NOTE = {
  title: 'Delivery note',
  body: 'Leave the blue crate at loading bay 4 before 14:30.',
};

export const NATIVE_FILES = ['invoice.pdf', 'invoice-total.txt', 'roster.txt', 'note.txt'];
export const SITE_PORT = 5431;
