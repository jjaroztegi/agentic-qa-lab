// Business rules of the MES, kept free of I/O so they are unit-testable.
import type { Coil } from "./db.ts";

export type CoilInput = {
  coil_no: string;
  heat_no: string;
  weight_kg: number;
  thickness_mm: number;
  width_mm: number;
  quality: "OK" | "HOLD";
};

// Hot strip mill envelope: anything outside is a typo, not a coil.
export const LIMITS = {
  weight_kg: [1_000, 40_000],
  thickness_mm: [1.2, 25.4],
  width_mm: [600, 2_100],
} as const;

export function parseCoil(form: Record<string, unknown>): { coil?: CoilInput; errors: string[] } {
  const errors: string[] = [];
  const text = (k: string) => String(form[k] ?? "").trim();
  const num = (k: keyof typeof LIMITS, label: string) => {
    const v = Number(text(k).replace(",", "."));
    const [min, max] = LIMITS[k];
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${label} must be between ${min} and ${max}`);
    return v;
  };
  const coil_no = text("coil_no");
  const heat_no = text("heat_no");
  if (!/^[A-Z0-9-]{4,20}$/.test(coil_no)) errors.push("Coil no. is not valid");
  if (!/^[0-9]{6}$/.test(heat_no)) errors.push("Heat no. must have 6 digits");
  const weight_kg = num("weight_kg", "Weight (kg)");
  const thickness_mm = num("thickness_mm", "Thickness (mm)");
  const width_mm = num("width_mm", "Width (mm)");
  const quality = text("quality") === "HOLD" ? "HOLD" : "OK";
  return errors.length
    ? { errors }
    : { coil: { coil_no, heat_no, weight_kg, thickness_mm, width_mm, quality }, errors };
}

// What the ERP is told was produced: only coils released by quality count.
export function producedTonnes(coils: Pick<Coil, "weight_kg" | "quality">[]): number {
  const kg = coils.filter((c) => c.quality === "OK").reduce((s, c) => s + c.weight_kg, 0);
  return Math.round(kg) / 1000;
}

// Tonnes always with kg precision: "47.750 t", "1,250.500 t".
export function formatTonnes(t: number): string {
  return `${t.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: true })} t`;
}

// Inbound interface contract ERP -> MES (one manufacturing order).
export type InboundOrder = {
  erp_ref: string;
  sale_ref: string | null;
  customer: string;
  product: string;
  grade: string;
  qty_t: number;
  due_date: string | null;
};

export function parseInboundOrder(p: any): { order?: InboundOrder; errors: string[] } {
  const errors: string[] = [];
  const str = (k: string, required = true) => {
    const v = p?.[k];
    if (v == null || v === "") {
      if (required) errors.push(`${k} is required`);
      return null;
    }
    if (typeof v !== "string") errors.push(`${k} must be text`);
    return String(v);
  };
  const erp_ref = str("erp_ref");
  const sale_ref = str("sale_ref", false);
  const customer = str("customer");
  const product = str("product");
  const grade = str("grade");
  const due_date = str("due_date", false);
  const qty_t = p?.qty_t;
  if (typeof qty_t !== "number" || !(qty_t > 0)) errors.push("qty_t must be a positive number (tonnes)");
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) errors.push("due_date must be YYYY-MM-DD");
  return errors.length
    ? { errors }
    : { order: { erp_ref: erp_ref!, sale_ref, customer: customer!, product: product!, grade: grade!, qty_t, due_date }, errors };
}

// Steel grade from the product name, e.g. "Hot-rolled coil S275JR" -> "S275JR".
export function gradeOf(productName: string): string {
  return productName.match(/\b(S\d{3}[A-Z0-9+]*|DC0\d|DD1\d)\b/)?.[1] ?? "N/A";
}

// --- Level 2 (L2 client): quality, measurements, downtime ---

// Tolerances per grade. Nominal thickness/width are the coil's own (they come with the order).
export type GradeSpec = { grade: string; thickness_tol_mm: number; width_tol_mm: { minus: number; plus: number }; flatness_max_iu: number };
export const GRADE_SPECS: GradeSpec[] = [
  { grade: "S275JR", thickness_tol_mm: 0.15, width_tol_mm: { minus: 0, plus: 10 }, flatness_max_iu: 15 },
  { grade: "S355J2", thickness_tol_mm: 0.12, width_tol_mm: { minus: 0, plus: 10 }, flatness_max_iu: 12 },
  { grade: "DD11", thickness_tol_mm: 0.1, width_tol_mm: { minus: 0, plus: 6 }, flatness_max_iu: 10 },
];
export const gradeSpec = (grade: string) => GRADE_SPECS.find((s) => s.grade === grade);

export const HOLD_MOTIVES = ["Flatness defect", "Thickness out of tolerance", "Width out of tolerance", "Surface defect", "Damaged edges"];
export const RELEASE_MOTIVES = ["Reinspection passed", "Customer concession", "Measurement error"];
export const STOP_REASONS = ["Roll change", "Mechanical failure", "Electrical failure", "Material shortage", "Process adjustment"];
// Only a shift supervisor may release a held coil.
export const SUPERVISORS: Record<string, string> = { S0412: "A. Morgan", S0587: "J. Reed", S0733: "M. Hale" };

type Range = [number, number];
export type Limits = { grade: string; thickness_mm: Range; width_mm: Range; flatness_iu: Range };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

export function coilLimits(coil: { grade: string; thickness_mm: number; width_mm: number }): Limits | null {
  const s = gradeSpec(coil.grade);
  if (!s) return null;
  return {
    grade: s.grade,
    thickness_mm: [r3(coil.thickness_mm - s.thickness_tol_mm), r3(coil.thickness_mm + s.thickness_tol_mm)],
    width_mm: [coil.width_mm - s.width_tol_mm.minus, coil.width_mm + s.width_tol_mm.plus],
    flatness_iu: [0, s.flatness_max_iu],
  };
}

export type Measurement = { thickness_mm: number; width_mm: number; flatness_iu: number };
const MEASURE_FIELDS = [
  { key: "thickness_mm", label: "Thickness", unit: "mm", motive: "Thickness out of tolerance", max: 30 },
  { key: "width_mm", label: "Width", unit: "mm", motive: "Width out of tolerance", max: 2500 },
  { key: "flatness_iu", label: "Flatness", unit: "I", motive: "Flatness defect", max: 200 },
] as const;

export function parseMeasurement(p: any): { m?: Measurement; errors: string[] } {
  const errors: string[] = [];
  const m: Record<string, number> = {};
  for (const f of MEASURE_FIELDS) {
    const v = Number(String(p?.[f.key] ?? "").trim().replace(",", "."));
    if (String(p?.[f.key] ?? "").trim() === "" || !Number.isFinite(v) || v < 0 || v > f.max || (v === 0 && f.key !== "flatness_iu"))
      errors.push(`${f.label} (${f.unit}) is not valid`);
    m[f.key] = v;
  }
  return errors.length ? { errors } : { m: m as Measurement, errors };
}

export type Failure = { field: string; motive: string; message: string };
// Out-of-tolerance dimensions, in check order; the first one gives the hold motive.
export function evaluateMeasurement(m: Measurement, l: Limits): Failure[] {
  return MEASURE_FIELDS.flatMap((f) => {
    const [min, max] = l[f.key];
    const v = m[f.key];
    return v < min || v > max
      ? [{ field: f.key, motive: f.motive, message: `${f.label} ${fmt(v)} ${f.unit} outside ${fmt(min)}–${fmt(max)} ${f.unit}` }]
      : [];
  });
}

const pick = (list: string[], v: unknown) => list.find((x) => x.toLowerCase() === String(v ?? "").trim().toLowerCase());
const optText = (v: unknown) => String(v ?? "").trim() || null;

export function parseHold(p: any): { hold?: { motive: string; comment: string | null }; errors: string[] } {
  const motive = pick(HOLD_MOTIVES, p?.motive);
  return motive ? { hold: { motive, comment: optText(p?.comment) }, errors: [] } : { errors: [`motive must be one of: ${HOLD_MOTIVES.join(", ")}`] };
}

export function parseRelease(p: any): { release?: { motive: string; supervisor: string; comment: string | null }; errors: string[] } {
  const errors: string[] = [];
  const motive = pick(RELEASE_MOTIVES, p?.motive);
  const supervisor = String(p?.supervisor ?? "").trim().toUpperCase();
  if (!motive) errors.push(`motive must be one of: ${RELEASE_MOTIVES.join(", ")}`);
  if (!supervisor) errors.push("Release requires the supervisor number");
  else if (!SUPERVISORS[supervisor]) errors.push(`${supervisor} is not a shift supervisor`);
  return errors.length ? { errors } : { release: { motive: motive!, supervisor, comment: optText(p?.comment) }, errors };
}

// Plant times are naive local "YYYY-MM-DDTHH:MM" strings (the line runs on plant time); minutes since epoch for arithmetic.
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const toMin = (t: string) => Date.parse(`${t}:00Z`) / 60_000;
export const fromMin = (m: number) => new Date(m * 60_000).toISOString().slice(0, 16);

export type Stop = { start_at: string; end_at: string; reason: string; comment: string | null };
export function parseStop(p: any, existing: Pick<Stop, "start_at" | "end_at">[]): { stop?: Stop; errors: string[] } {
  const errors: string[] = [];
  const start_at = String(p?.start_at ?? "").trim();
  const end_at = String(p?.end_at ?? "").trim();
  const reason = pick(STOP_REASONS, p?.reason);
  const okTimes = TS.test(start_at) && TS.test(end_at) && Number.isFinite(toMin(start_at)) && Number.isFinite(toMin(end_at));
  if (!okTimes) errors.push("start_at and end_at must be YYYY-MM-DDTHH:MM");
  else if (toMin(end_at) <= toMin(start_at)) errors.push("The stop must end after it starts");
  else if (toMin(end_at) - toMin(start_at) > 12 * 60) errors.push("A stop cannot last more than 12 h; record it per shift");
  else {
    const clash = existing.find((s) => toMin(start_at) < toMin(s.end_at) && toMin(s.start_at) < toMin(end_at));
    if (clash) errors.push(`Overlaps the stop ${clash.start_at.replace("T", " ")}–${clash.end_at.slice(11)}`);
  }
  if (!reason) errors.push(`reason must be one of: ${STOP_REASONS.join(", ")}`);
  return errors.length ? { errors } : { stop: { start_at, end_at, reason: reason!, comment: optText(p?.comment) }, errors };
}

// Shifts: Morning 06-14, Afternoon 14-22, Night 22-06 (belongs to the date it starts on).
// The codes M/T/N are part of the API contract (L2 client, ?shift=), so they keep their original letters.
export const SHIFTS = { M: { name: "Morning", from: 6 }, T: { name: "Afternoon", from: 14 }, N: { name: "Night", from: 22 } } as const;
export type ShiftCode = keyof typeof SHIFTS;

export function shiftWindow(date: string, shift: ShiftCode): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SHIFTS[shift] || !Number.isFinite(Date.parse(date))) return null;
  const from = toMin(`${date}T00:00`) + SHIFTS[shift].from * 60;
  return { from: fromMin(from), to: fromMin(from + 8 * 60) };
}

// Availability = (planned time - stop time inside the shift) / planned time. Stops never overlap (parseStop).
export function availability(stops: Pick<Stop, "start_at" | "end_at">[], w: { from: string; to: string }) {
  const [a, b] = [toMin(w.from), toMin(w.to)];
  const stop_min = stops.reduce((s, x) => s + Math.max(0, Math.min(b, toMin(x.end_at)) - Math.max(a, toMin(x.start_at))), 0);
  const planned_min = b - a;
  return { planned_min, stop_min, availability_pct: Math.round(((planned_min - stop_min) / planned_min) * 1000) / 10 };
}
