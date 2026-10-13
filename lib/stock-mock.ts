// Sample Stock Summary rows, used only when the dashboard runs without Zoho credentials (the same "sample data"
// mode as the other tabs). Made up, but shaped like the real thing: products with an old and a "_New" SKU,
// negative stock, a big and a small product.

import type { StockRow } from './stock-calculator';

let n = 0;
const row = (name: string, opening: number, qtyIn: number, qtyOut: number, closing: number, closingValue: number, unit = 'Nos'): StockRow & { unit: string } => ({
  itemId: `mock${++n}`, name, opening, qtyIn, qtyOut, closing, closingValue, unit,
});

const SAMPLE = [
  row('Solar Module 540Wp', -720, 720, 0, 0, 0),
  row('Solar Module 540Wp', 863, 3124, 3844, 143, 1350724),
  row('Solar Inverter 110kW', 40, 18, 22, 36, 5760000),
  row('Battery Energy Storage System', 7, 0, 6, 1, 5102996),
  row('Battery Energy Storage System', -3, 3, 0, 0, 0),
  row('LT Panel 400A', 82, 10, 40, 52, 3120000),
  row('DC Cable 4 Sqmm', 120000, 80000, 150000, 50000, 1450000, 'Mtr'),
  row('AC Cable 3.5C x 185 Sqmm', 4200, 1800, 3900, 2100, 7140000, 'Mtr'),
  row('Earthing Strip 25x6mm', 2500, 0, 1775, 725, 580000, 'Mtr'),
  row('Mounting Structure Rafter', 52000, 41000, 66000, 27000, 2160000, 'Kgs'),
  row('Distribution Transformer 500kVA', 3, 2, 1, 4, 3880000),
  row('1C X 240 Sqmm cable', 928, 0, 0, 928, 295104, 'Mtr'),
  row('1C X 240 Sqmm cable', -928, 0, 0, -928, 0, 'Mtr'),
  row('4C X 16 Sqmm AI Arm Cable', 359, 0, 0, 359, 37695, 'Mtr'),
  row('4C X 16 Sqmm AI Arm Cable', -359, 0, 0, -359, 0, 'Mtr'),
  row('FUSE', -3, 0, 0, -3, -3),
  row('PG Clamp', -3, 0, 3, -6, 1680),
  row('Shock Treatment Chart', -9, 0, 0, -9, 0),
  row('LCL Fan Black', -11, 0, 0, -11, 21800),
  row('MC4 Connector', 1800, 600, 1500, 900, 63000),
  row('Lug 16 Sqmm', 2200, 0, 400, 1800, 27000),
  row('Cable Tie 300mm', 9000, 5000, 7000, 7000, 21000),
  row('Danger Board', 60, 20, 10, 70, 28000),
  row('Fire Extinguisher 4kg', 12, 0, 2, 10, 24000),
  row('Safety Helmet', 150, 50, 120, 80, 32000),
  row('Rubber Gloves 11kV', 24, 0, 4, 20, 46000),
  row('Spare Item Not Used', 0, 0, 0, 0, 0),
];

export function mockStockRows(): StockRow[] {
  return SAMPLE.map(({ unit: _unit, ...r }) => r);
}
export function mockUnits(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of SAMPLE) out[r.itemId] = r.unit;
  return out;
}
