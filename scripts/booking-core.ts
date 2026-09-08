import crypto from "crypto";

export interface CollectionRequest {
  date: string;
  earliest: string;
  latest: string;
  packages: number;
  weight: number;
  doorCode: string | null;
}

export interface CollectionOptionsInput {
  date?: string;
  packages?: number;
  weight?: number;
  earliest?: string;
  latest?: string;
  earliestTime?: string;
  latestTime?: string;
  doorCode?: string;
  skipDoorCode?: boolean;
  specialInstructions?: string;
  forbidDate?: string;
  forbiddenDate?: string;
}

export interface ResolvedCollectionRequest extends CollectionRequest {
  specialInstructions: string;
  datePolicy: DatePolicy;
}

export type DateIntent = "smart" | "today" | "tomorrow" | "explicit";

export interface DatePolicy {
  requested: string | null;
  intent: DateIntent;
  date: string;
  nowUk: string;
  cutoffHourUk: number;
  afterCutoff: boolean;
  forbiddenDates: string[];
  ok: boolean;
  reason: string | null;
  safeNextCommand: string | null;
}

export interface ValidationInput {
  expected: CollectionRequest & { specialInstructions?: string };
  text: string;
  controls?: Partial<{
    earliestHour: string;
    earliestMin: string;
    latestHour: string;
    latestMin: string;
    earliestPM: boolean;
    latestPM: boolean;
    instructions: string;
  }>;
  billTo?: BillToEvidence;
}

export interface BillToEvidence {
  savedAccountChecked: boolean;
  savedAccountIdentifier: string;
  accountNumber: string;
  country: string;
  postalCode: string;
  continueEnabled: boolean;
}

export interface ValidationResult {
  ok: boolean;
  missing: string[];
  charge: string | null;
}

export interface RequiredFieldState {
  name: string;
  expected: string;
  actual: string | null;
}

export interface LabelLocationBlock {
  blocked: boolean;
  errors: string[];
}

export type PaymentState =
  | "dateTimeReady"
  | "savedBillToSelected"
  | "explicitBillToFields"
  | "reviewReady"
  | "autoConfirmed"
  | "serviceError"
  | "unknown";

export interface PaymentStateResult {
  state: PaymentState;
  charge: string | null;
  confirmationNumber: string | null;
  billToAccountVisible: boolean;
  explicitAccountFieldsVisible: boolean;
  serviceError: boolean;
  reviewReady: boolean;
}

export interface ConfirmationResult {
  confirmed: boolean;
  confirmationNumber: string | null;
  charge: string | null;
  text: string;
}

export interface CalendarEventSpec {
  summary: string;
  start: string;
  end: string;
  timezone: string;
  location: string;
  attendees: string;
  description: string;
  sendUpdates: "all";
}

const ADDRESS_RE = /Unit B,\s*YOUR_WAREHOUSE_ADDRESS_LINE_1,\s*YOUR_WAREHOUSE_ADDRESS_LINE_2,\s*YOUR_CITY,?\s*YOUR_POSTCODE/is;
export const UPS_SAME_DAY_CUTOFF_HOUR_UK = 12;
export const MAX_EXPECTED_CHARGE_GBP = 10;
const EXPECTED_BILL_TO_ACCOUNT = "YOUR_UPS_ACCOUNT_ID";
const EXPECTED_BILL_TO_COUNTRY = "GB";
const EXPECTED_BILL_TO_POSTCODE = "YOUR_WAREHOUSE_POSTCODE";

export type AttemptStatus =
  | "started"
  | "blocked"
  | "date_time_ready"
  | "payment_step_reached"
  | "pre_submit_failed"
  | "submit_clicked"
  | "pending_verification"
  | "confirmed"
  | "calendar_failed"
  | "failed";

export interface AttemptManifestLike {
  fingerprint: string;
  status: AttemptStatus;
  submitClicked?: boolean;
  confirmationNumber?: string | null;
  message?: string | null;
}

export type DoorCodeLookupMethod =
  | "channel-history"
  | "channel-search"
  | "phrase-search";

export interface DoorCodeLookupAttempt {
  method: DoorCodeLookupMethod;
  read: () => unknown;
}

export interface DoorCodeLookupDiagnostic {
  method: DoorCodeLookupMethod;
  status: "found" | "no-match" | "failed";
  reason: "door-code-found" | "no-matching-door-code" | "slack-command-failed";
}

export interface DoorCodeLookupResult {
  code: string | null;
  diagnostics: DoorCodeLookupDiagnostic[];
}

export function extractLatestDoorCode(payload: unknown): string | null {
  const strings = collectStrings(payload);
  for (const text of strings) {
    const match = text.match(/\b(\d{3})[-\s]?(\d{3})[-\s]?(\d{3})\b/);
    if (match) return `${match[1]}${match[2]}${match[3]}`;
  }
  return null;
}

export function lookupLatestDoorCode(
  attempts: readonly DoorCodeLookupAttempt[],
): DoorCodeLookupResult {
  const diagnostics: DoorCodeLookupDiagnostic[] = [];

  for (const attempt of attempts) {
    try {
      const code = extractLatestDoorCode(attempt.read());
      if (code) {
        diagnostics.push({
          method: attempt.method,
          status: "found",
          reason: "door-code-found",
        });
        return { code, diagnostics };
      }
      diagnostics.push({
        method: attempt.method,
        status: "no-match",
        reason: "no-matching-door-code",
      });
    } catch {
      diagnostics.push({
        method: attempt.method,
        status: "failed",
        reason: "slack-command-failed",
      });
    }
  }

  return { code: null, diagnostics };
}

export function formatDoorCodeLookupDiagnostic(
  diagnostic: DoorCodeLookupDiagnostic,
): string {
  return `[ups-door-code] ${diagnostic.method}: ${diagnostic.reason}`;
}

export function getSmartCollectionDate(now = new Date()): string {
  const uk = getUkParts(now);
  const target = new Date(Date.UTC(uk.year, uk.month - 1, uk.day, 12));
  if (uk.hour >= UPS_SAME_DAY_CUTOFF_HOUR_UK) target.setUTCDate(target.getUTCDate() + 1);
  while ([0, 6].includes(target.getUTCDay())) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString().slice(0, 10);
}

export function normalizeCollectionOptions(
  options: CollectionOptionsInput,
  fallbackDoorCode: string | null = null,
  now = new Date(),
): ResolvedCollectionRequest {
  const datePolicy = resolveDatePolicy(options, now);
  if (!datePolicy.ok) {
    throw new Error(datePolicy.reason ?? `UPS collection date ${datePolicy.date} is not allowed.`);
  }
  const date = datePolicy.date;
  const packages = options.packages ?? 1;
  const weight = options.weight ?? 10;
  const earliest = normalizeTime(options.earliest ?? options.earliestTime ?? "12:00", "earliest");
  const latest = normalizeTime(options.latest ?? options.latestTime ?? "18:00", "latest");
  if (options.skipDoorCode && options.doorCode) {
    throw new Error("Use either --door-code or --skip-door-code, not both.");
  }
  const doorCode = options.skipDoorCode
    ? null
    : normalizeDoorCode(options.doorCode) ?? normalizeDoorCode(fallbackDoorCode ?? undefined);
  if (timeToMinutes(latest) <= timeToMinutes(earliest)) {
    throw new Error(`Invalid UPS collection time window: latest time ${latest} must be after earliest time ${earliest}.`);
  }

  if (!Number.isInteger(packages) || packages < 1 || packages > 99) {
    throw new Error(`Invalid package count: ${packages}`);
  }
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    throw new Error(`Invalid collection weight: ${weight}`);
  }
  const specialInstructions = options.specialInstructions ?? (doorCode ? `Door code * ${doorCode} #` : "");
  if (specialInstructions.length > 57) {
    throw new Error(`UPS special instructions are limited to 57 characters; got ${specialInstructions.length}.`);
  }

  return { date, packages, weight, earliest, latest, doorCode, specialInstructions, datePolicy };
}

export function resolveDatePolicy(options: CollectionOptionsInput, now = new Date()): DatePolicy {
  const requested = options.date?.trim() || null;
  const parsed = parseDateIntent(requested, now);
  const uk = getUkParts(now);
  const today = londonIsoDate(0, now);
  const afterCutoff = uk.hour >= UPS_SAME_DAY_CUTOFF_HOUR_UK;
  const nowUk = `${String(uk.year).padStart(4, "0")}-${String(uk.month).padStart(2, "0")}-${String(uk.day).padStart(2, "0")}T${String(uk.hour).padStart(2, "0")}:00`;
  const forbiddenDates = parseForbiddenDates(options, now);
  let ok = true;
  let reason: string | null = null;

  if (afterCutoff && parsed.date === today && parsed.intent !== "smart") {
    ok = false;
    reason = `UPS same-day collection cutoff is ${String(UPS_SAME_DAY_CUTOFF_HOUR_UK).padStart(2, "0")}:00 Europe/London; ${parsed.date} can no longer be booked safely.`;
  } else if (forbiddenDates.includes(parsed.date)) {
    ok = false;
    reason = `UPS collection date ${parsed.date} is forbidden by the operator request.`;
  }

  return {
    requested,
    intent: parsed.intent,
    date: parsed.date,
    nowUk,
    cutoffHourUk: UPS_SAME_DAY_CUTOFF_HOUR_UK,
    afterCutoff,
    forbiddenDates,
    ok,
    reason,
    safeNextCommand: null,
  };
}

export function generateTotp(secret: string, timestampMs = Date.now(), digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(value).padStart(digits, "0");
}

export function validatePreSubmitSummary(input: ValidationInput): ValidationResult {
  const text = normalizeWhitespace(input.text);
  const controls = input.controls ?? {};
  const expected = input.expected;
  const missing: string[] = [];

  if (!dateAppears(text, expected.date)) missing.push("date");
  if (!ADDRESS_RE.test(text)) missing.push("address");
  if (!new RegExp(`Number\\s*of\\s*Parcels\\s*(?:edit\\s*)?${expected.packages}\\b`, "i").test(text)) {
    missing.push("packages");
  }
  if (!new RegExp(`Total\\s*Weight\\s*(?:edit\\s*)?${expected.weight}\\b`, "i").test(text)) {
    missing.push("weight");
  }
  const expectedInstructions = expected.specialInstructions ?? (expected.doorCode ? `Door code * ${expected.doorCode} #` : "");
  if (expectedInstructions) {
    if (!text.includes(expectedInstructions) && controls.instructions !== expectedInstructions) {
      missing.push(expected.doorCode ? "doorCode" : "specialInstructions");
    }
  } else if (controls.instructions !== undefined && controls.instructions.trim() !== "") {
    missing.push("specialInstructions");
  }
  if (!/UPS Standard/i.test(text)) missing.push("standard");
  if (!timeWindowAppears(text, controls, expected)) missing.push("timeWindow");
  if (/\bBill To\b/i.test(text) && !billToEvidenceReady(input.billTo)) missing.push("billTo");

  const charge = extractCharge(text);
  if (charge && !chargeIsSane(charge)) missing.push("chargeOutOfRange");
  return { ok: missing.length === 0, missing, charge };
}

export function billToEvidenceReady(evidence?: BillToEvidence): boolean {
  if (!evidence?.continueEnabled) return false;
  if (
    evidence.savedAccountChecked
    && evidence.savedAccountIdentifier.toUpperCase().includes(EXPECTED_BILL_TO_ACCOUNT)
  ) return true;
  return evidence.accountNumber.trim().toUpperCase() === EXPECTED_BILL_TO_ACCOUNT
    && evidence.country.trim().toUpperCase() === EXPECTED_BILL_TO_COUNTRY
    && compactFieldValue(evidence.postalCode) === compactFieldValue(EXPECTED_BILL_TO_POSTCODE);
}

export function findClearedRequiredFields(fields: RequiredFieldState[]): string[] {
  const cleared: string[] = [];

  for (const field of fields) {
    const expected = normalizeFieldValue(field.expected);
    const actual = normalizeFieldValue(field.actual ?? "");
    if (expected === actual) continue;
    if (compactFieldValue(expected) === compactFieldValue(actual)) continue;
    cleared.push(field.name);
  }

  return cleared;
}

export function detectLabelLocationBlock(textInput: string): LabelLocationBlock {
  const text = normalizeWhitespace(textInput);
  const errors: string[] = [];

  const requiredFieldPattern = /([A-Za-z][A-Za-z/ ]{1,40}?) is required\b/gi;
  let match = requiredFieldPattern.exec(text);
  while (match !== null) {
    const fieldName = dedupeRepeatedLabel(match[1].trim());
    if (fieldName && !errors.includes(fieldName)) errors.push(fieldName);
    match = requiredFieldPattern.exec(text);
  }

  const hasErrorBanner = /Please correct the following\s+\d+\s+errors?/i.test(text);
  return { blocked: hasErrorBanner || errors.length > 0, errors };
}

function dedupeRepeatedLabel(value: string): string {
  const words = value.split(" ");
  if (words.length % 2 !== 0) return value;

  const half = words.length / 2;
  const firstHalf = words.slice(0, half).join(" ");
  const secondHalf = words.slice(half).join(" ");
  return firstHalf.toLowerCase() === secondHalf.toLowerCase() ? firstHalf : value;
}

function normalizeFieldValue(value: string): string {
  return normalizeWhitespace(value).trim().toLowerCase();
}

function compactFieldValue(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function classifyPaymentState(
  textInput: string,
  fallbackCharge: string | null = null,
  billTo?: BillToEvidence,
): PaymentStateResult {
  const text = normalizeWhitespace(textInput);
  const confirmation = extractConfirmation(text, fallbackCharge);
  const charge = extractCharge(text) ?? fallbackCharge;
  const serviceError = /temporarily unavailable|unable to process|service unavailable|try again later|current service is unavailable/i.test(text);
  const billToAccountVisible = /YOUR_UPS_ACCOUNT_ID/i.test(text);
  const explicitAccountFieldsVisible = /UPS Shipping Account Number|Postcode for UPS Account|Bill To Country|Bill To Postcode/i.test(text);
  const hasChooser = /Payment Method/i.test(text) && /My UPS Shipping Account/i.test(text);
  const reviewReady = billToEvidenceReady(billTo) && charge !== null && chargeIsSane(charge) && !serviceError;
  let state: PaymentState = "unknown";

  if (confirmation.confirmed && confirmation.confirmationNumber) {
    state = "autoConfirmed";
  } else if (serviceError) {
    state = "serviceError";
  } else if (reviewReady) {
    state = "reviewReady";
  } else if (explicitAccountFieldsVisible) {
    state = "explicitBillToFields";
  } else if (hasChooser) {
    state = "savedBillToSelected";
  } else if (charge && /Choose Payment Method|Date and Time/i.test(text)) {
    state = "dateTimeReady";
  }

  return {
    state,
    charge,
    confirmationNumber: confirmation.confirmationNumber,
    billToAccountVisible,
    explicitAccountFieldsVisible,
    serviceError,
    reviewReady,
  };
}

export function isUpsUsernameContinueInterstitial(textInput: string): boolean {
  const text = normalizeWhitespace(textInput);
  return /Email or Username/i.test(text) &&
    /Forgot Username\/Password/i.test(text) &&
    /By Continuing, I agree to the UPS Technology Agreement/i.test(text) &&
    /\bContinue\b/i.test(text) &&
    !/Password\s*\*/i.test(text);
}

export function isUpsMfaChallenge(input: { url: string; title: string; text: string }): boolean {
  return /\/mfa-(?:login-options|challenge)\b/i.test(input.url) ||
    /List of other login methods|Verify Your Identity/i.test(input.title) ||
    /Verify Your Identity|Authenticator Apps|one-time|verification code|Recovery code/i.test(input.text);
}

export function extractConfirmation(text: string, fallbackCharge: string | null = null): ConfirmationResult {
  const normalized = normalizeWhitespace(text);
  const number = normalized.match(/Collection Request Number:\s*([A-Z0-9]{8,})/i)?.[1] ?? null;
  const confirmed = /Thank you for Your Business!/i.test(normalized) && number !== null;
  return {
    confirmed,
    confirmationNumber: number,
    charge: extractCharge(normalized) ?? fallbackCharge,
    text: normalized,
  };
}

export function buildCalendarEvent(input: Omit<CollectionRequest, "doorCode"> & { confirmationNumber: string; charge: string | null }): CalendarEventSpec {
  const offset = londonOffset(input.date);
  const start = `${input.date}T${input.earliest}:00${offset}`;
  const end = `${input.date}T${addOneHour(input.earliest)}:00${offset}`;
  return {
    summary: `UPS Collection - ${input.confirmationNumber}`,
    start,
    end,
    timezone: "Europe/London",
    location: "YOUR_WAREHOUSE_ADDRESS_LINE_1, YOUR_WAREHOUSE_ADDRESS_LINE_2, YOUR_CITY, YOUR_POSTCODE",
    attendees: "support@your-company.com,warehouse@your-company.com",
    sendUpdates: "all",
    description: [
      "UPS Collection Confirmed",
      "",
      `Confirmation Number: ${input.confirmationNumber}`,
      `Collection Window: ${formatTime(input.earliest)} - ${formatTime(input.latest)}`,
      `Packages: ${input.packages}`,
      `Weight: ${input.weight} kg`,
      `Charges: ${input.charge ?? "unknown"}`,
    ].join("\n"),
  };
}

export function dateTextCandidates(isoDate: string): string[] {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const monthLong = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const monthShort = date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const monthLongUs = date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const weekdayUs = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const weekdayGb = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const day = date.getUTCDate();
  const padded = String(day).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();

  return [
    isoDate,
    `${padded}/${month}/${year}`,
    `${month}/${padded}/${year}`,
    `${day} ${monthLong} ${year}`,
    `${padded} ${monthShort} ${year}`,
    `${monthLong} ${padded}, ${year}`,
    `${monthLong} ${day}, ${year}`,
    `${weekdayUs}, ${monthLongUs} ${padded}, ${year}`,
    `${weekdayUs}, ${monthLongUs} ${day}, ${year}`,
    `${weekdayGb}, ${day} ${monthLong} ${year}`,
  ];
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function extractCharge(text: string): string | null {
  return text.match(/(?:Total Charges?:?\s*)?(£\s?\d+(?:\.\d{2})?)/i)?.[1]?.replace(/\s+/g, "") ?? null;
}

export function chargeIsSane(charge: string): boolean {
  const match = charge.match(/£\s?(\d+(?:\.\d{2})?)/);
  if (!match?.[1]) return false;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= MAX_EXPECTED_CHARGE_GBP;
}

export function shouldBlockBookingAttempt(
  attempts: AttemptManifestLike[],
  fingerprint: string,
): { blocked: boolean; reason: string | null; status: AttemptStatus | null } {
  const matching = attempts.filter(attempt => attempt.fingerprint === fingerprint);
  const blocker = matching.find(attempt => {
    if (!["confirmed", "calendar_failed", "pending_verification", "submit_clicked"].includes(attempt.status)) {
      return false;
    }
    return true;
  });
  if (!blocker) return { blocked: false, reason: null, status: null };
  if (blocker.status === "confirmed" || blocker.status === "calendar_failed") {
    return { blocked: true, reason: "A UPS collection is already confirmed for this request fingerprint.", status: blocker.status };
  }
  return {
    blocked: true,
    reason: "A previous UPS booking attempt may have reached a submit/final payment action and needs verification before retrying.",
    status: blocker.status,
  };
}

export function requestFingerprint(input: Omit<CollectionRequest, "doorCode">): string {
  return [
    input.date,
    input.earliest,
    input.latest,
    input.packages,
    input.weight,
    "YOUR_WAREHOUSE_ADDRESS_LINE_1, YOUR_WAREHOUSE_ADDRESS_LINE_2, YOUR_CITY, YOUR_POSTCODE",
    "UPS Standard",
    "YOUR_UPS_ACCOUNT_ID",
  ].join("|");
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

function getUkParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const raw of input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "")) {
    const value = alphabet.indexOf(raw);
    if (value >= 0) bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function dateAppears(text: string, isoDate: string): boolean {
  return dateTextCandidates(isoDate).some(candidate => text.includes(candidate));
}

function timeWindowAppears(text: string, controls: ValidationInput["controls"], expected: CollectionRequest): boolean {
  const earliest = timeParts(expected.earliest);
  const latest = timeParts(expected.latest);
  const controlsMatch = controls?.earliestHour?.padStart(2, "0") === earliest.hour12 &&
    controls?.earliestMin === earliest.minute &&
    controls?.latestHour?.padStart(2, "0") === latest.hour12 &&
    controls?.latestMin === latest.minute &&
    controls?.earliestPM === (earliest.period === "PM") &&
    controls?.latestPM === (latest.period === "PM");
  const textMatch = new RegExp(`Earliest time\\s*${Number(earliest.hour12)}:${earliest.minute}\\s*${earliest.period}`, "i").test(text) &&
    new RegExp(`Latest time\\s*${Number(latest.hour12)}:${latest.minute}\\s*${latest.period}`, "i").test(text);
  return controlsMatch || textMatch;
}

function timeParts(time: string): { hour12: string; minute: string; period: "AM" | "PM" } {
  const [hourRaw, minute = "00"] = time.split(":");
  const hour24 = Number(hourRaw);
  const hour12 = String(((hour24 + 11) % 12) + 1).padStart(2, "0");
  return { hour12, minute, period: hour24 >= 12 ? "PM" : "AM" };
}

function parseDateIntent(value: string | null, now: Date): { date: string; intent: DateIntent } {
  if (!value) return { date: getSmartCollectionDate(now), intent: "smart" };
  const lower = value.trim().toLowerCase();
  if (lower === "today") return { date: londonIsoDate(0, now), intent: "today" };
  if (lower === "tomorrow") return { date: londonIsoDate(1, now), intent: "tomorrow" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return { date: lower, intent: "explicit" };
  throw new Error(`Invalid collection date "${value}". Use YYYY-MM-DD, today, or tomorrow.`);
}

function parseForbiddenDates(options: CollectionOptionsInput, now: Date): string[] {
  const raw = [options.forbidDate, options.forbiddenDate].filter((value): value is string => Boolean(value));
  return raw
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => parseDateIntent(value, now).date);
}

function normalizeTime(value: string, label: string): string {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid ${label} time "${value}". Use HH:MM.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid ${label} time "${value}". Use 00:00-23:59.`);
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeDoorCode(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\D/g, "");
  if (!/^\d{9}$/.test(compact)) {
    throw new Error(`Invalid door code "${value}". Expected 9 digits.`);
  }
  return compact;
}

function londonIsoDate(offsetDays: number, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + offsetDays, 12));
  return date.toISOString().slice(0, 10);
}

function londonOffset(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const zone = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(date).find(part => part.type === "timeZoneName")?.value ?? "GMT";
  const match = zone.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "+00:00";
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

function addOneHour(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${String((hour + 1) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatTime(time: string): string {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelveHour = ((hour + 11) % 12) + 1;
  return `${twelveHour}:${minute} ${suffix}`;
}

