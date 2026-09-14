
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { secureStatePath, secureWrite } from "./vendor/secure-state/index.js";
import {
  buildCalendarEvent,
  classifyPaymentState,
  dateTextCandidates,
  detectLabelLocationBlock,
  extractConfirmation,
  findClearedRequiredFields,
  formatDoorCodeLookupDiagnostic,
  generateTotp,
  isUpsMfaChallenge,
  isUpsUsernameContinueInterstitial,
  lookupLatestDoorCode,
  normalizeCollectionOptions,
  normalizeWhitespace,
  billToEvidenceReady,
  requestFingerprint,
  resolveDatePolicy,
  shouldBlockBookingAttempt,
  validatePreSubmitSummary,
  type AttemptManifestLike,
  type AttemptStatus,
  type BillToEvidence,
  type CollectionOptionsInput,
  type DatePolicy,
  type ResolvedCollectionRequest,
  type ValidationInput,
  type ValidationResult,
} from "./booking-core.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = MODULE_DIR.endsWith(`${sep}dist`) ? dirname(MODULE_DIR) : MODULE_DIR;
const BIZ_ROOT = dirname(dirname(SERVICE_DIR));
const SLACK_DIR = join(BIZ_ROOT, "scripts", "slack-manager");
const GOOGLE_WORKSPACE_DIR = join(BIZ_ROOT, "scripts", "google-workspace-manager");

const SESSION_PATH = secureStatePath("ups", "cdp-session.json");
const PROFILE_DIR = secureStatePath("ups", "chrome-cdp-profile");
const ARTIFACT_DIR = join(process.env.HOME ?? BIZ_ROOT, "biz", ".playwright-mcp", "ups-collection-manager");
const ATTEMPT_DIR = join(ARTIFACT_DIR, "attempts");
const LATEST_ATTEMPT_PATH = join(ATTEMPT_DIR, "latest.json");

const DOOR_CODE_CHANNEL = "YOUR_SLACK_CHANNEL_ID";
const CDP_HOST = "127.0.0.1";
const UPS_LOGIN_URL = "https://www.ups.com/lasso/login?loc=en_GB&returnto=https%3A%2F%2Fwwwapps.ups.com%2Fpickup%2Fschedule%3Floc%3Den_GB";
const UPS_FORM_URL = "https://wwwapps.ups.com/pickup/schedule?loc=en_GB";

const DEFAULTS = {
  company: "YOUR_COMPANY",
  contact: "YOUR_NAME",
  address1: "YOUR_WAREHOUSE_ADDRESS_LINE_1, YOUR_WAREHOUSE_ADDRESS_LINE_2",
  address2: "",
  address3: "",
  city: "YOUR_CITY",
  postalCode: "YOUR_POSTCODE",
  phone: "YOUR_PHONE_NUMBER",
  email: "YOUR_LOGISTICS_EMAIL",
  parcelLocation: "Front Door",
  paymentAccountNumber: "YOUR_UPS_ACCOUNT_ID",
  paymentAccountCountry: "GB",
  paymentAccountPostcode: "YOUR_WAREHOUSE_POSTCODE",
};

export type CollectionOptions = CollectionOptionsInput;

interface CdpSession {
  port: number;
  cdpUrl: string;
  profileDir: string;
  chromePid?: number;
  launchedAt: string;
}

interface Checkpoint extends ValidationResult {
  phase: "date-time" | "pay-review";
  screenshot: string;
  json: string;
  text: string;
  billTo: BillToEvidence;
}

type TimePeriod = "AM" | "PM";
type RunMode = "book" | "dry-run";
type RunStage =
  | "preflight"
  | "resolve-request"
  | "browser"
  | "login"
  | "label-location"
  | "label-location-advance"
  | "date-time"
  | "date-time-checkpoint"
  | "choose-payment"
  | "pay-review-checkpoint"
  | "final-submit"
  | "confirmation"
  | "calendar"
  | "complete"
  | "error";

interface AttemptManifest extends AttemptManifestLike {
  schemaVersion: 1;
  runId: string;
  mode: RunMode;
  stage: RunStage;
  submitClicked: boolean;
  status: AttemptStatus;
  createdAt: string;
  updatedAt: string;
  request: Record<string, unknown>;
  datePolicy: DatePolicy;
  artifacts: Record<string, string | null>;
  charge: string | null;
  confirmationNumber: string | null;
  message: string | null;
  safeNextCommand: string | null;
  humanUnlock: string | null;
}

const STAGE_TIMEOUTS: Record<RunStage, number> = {
  preflight: 5_000,
  "resolve-request": 20_000,
  browser: 45_000,
  login: 90_000,
  "label-location": 45_000,
  "label-location-advance": 15_000,
  "date-time": 45_000,
  "date-time-checkpoint": 20_000,
  "choose-payment": 45_000,
  "pay-review-checkpoint": 20_000,
  "final-submit": 45_000,
  confirmation: 20_000,
  calendar: 20_000,
  complete: 5_000,
  error: 5_000,
};

export class UPSClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private activeAttempt: AttemptManifest | null = null;
  private activeLockPath: string | null = null;

  constructor() {
    mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    mkdirSync(ATTEMPT_DIR, { recursive: true, mode: 0o700 });
  }

  async book(options: CollectionOptions): Promise<Record<string, unknown>> {
    return this.runCollectionFlow(options, true);
  }

  async dryRun(options: CollectionOptions): Promise<Record<string, unknown>> {
    return this.runCollectionFlow(options, false);
  }

  async status(): Promise<Record<string, unknown>> {
    const attempt = this.readLatestAttempt();
    return {
      success: true,
      mode: "status",
      message: attempt
        ? `Last UPS run ${attempt.runId} is ${attempt.status} at ${attempt.stage}.`
        : "No UPS collection attempts have been recorded.",
      attempt,
      safeNextCommand: attempt?.safeNextCommand ?? null,
    };
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser) await browser.close();
  }

  async resetSession(options?: { clearProfile?: boolean }): Promise<Record<string, unknown>> {
    const deleted: string[] = [];

    try {
      if (this.browser) {
        await this.browser.close().catch(() => undefined);
      } else if (existsSync(SESSION_PATH)) {
        const session = this.readSession();
        if (session && await this.cdpAlive(session.port, 750)) {
          const browser = await chromium.connectOverCDP(session.cdpUrl);
          await browser.close().catch(() => undefined);
        }
      }

      this.browser = null;
      this.context = null;
      this.page = null;

      if (existsSync(SESSION_PATH)) {
        unlinkSync(SESSION_PATH);
        deleted.push(SESSION_PATH);
      }

      this.killChromeProfileProcesses();

      if (options?.clearProfile && existsSync(PROFILE_DIR)) {
        rmSync(PROFILE_DIR, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        });
        deleted.push(PROFILE_DIR);
      }

      return {
        success: true,
        message: options?.clearProfile
          ? "UPS Chrome session closed and profile cleared."
          : "UPS Chrome session closed. Persistent profile kept for faster future logins.",
        deleted,
      };
    } catch (error) {
      return {
        success: false,
        error: true,
        message: `Reset failed: ${errorMessage(error)}`,
        deleted,
      };
    }
  }

  private async runCollectionFlow(options: CollectionOptions, submit: boolean): Promise<Record<string, unknown>> {
    const runId = newRunId();
    const mode: RunMode = submit ? "book" : "dry-run";
    const now = new Date();
    const datePolicy = resolveDatePolicy(options, now);
    let request: ResolvedCollectionRequest | null = null;
    let page: Page | null = null;

    try {
      if (!datePolicy.ok) {
        return this.blockedResult(runId, mode, datePolicy.reason ?? "UPS date policy blocked this collection.", datePolicy);
      }

      request = await this.withStage("resolve-request", () => this.resolveRequest(options, now));
      const fingerprint = requestFingerprint(request);
      const block = submit ? shouldBlockBookingAttempt(this.readAttemptManifests(), fingerprint) : { blocked: false, reason: null, status: null };

      this.activeAttempt = this.createAttempt(runId, mode, fingerprint, request);
      this.writeAttempt(this.activeAttempt);

      if (block.blocked) {
        this.updateAttempt({
          status: "blocked",
          message: block.reason,
          safeNextCommand: "npm run cli -- status",
          humanUnlock: "Inspect the previous attempt artifacts or verify with UPS before deleting/overriding the attempt manifest.",
        });
        return this.failureResult(block.reason ?? "UPS booking blocked by previous attempt state.", request, null, runId, mode, datePolicy);
      }

      if (submit) {
        this.acquireAttemptLock(fingerprint);
      }

      page = await this.withStage("browser", () => this.ensurePage());
      const activePage = page;
      const activeRequest = request;
      activePage.setDefaultTimeout(15_000);
      activePage.setDefaultNavigationTimeout(60_000);
      await this.withStage("login", () => this.loginAndOpenForm(activePage));
      await this.withStage("label-location", () => this.fillLabelAndLocation(activePage, activeRequest));
      await this.clickButton(activePage, /^Select Date & Time$/i, [
        'button:has-text("Select Date & Time")',
        'button:has-text("Date & Time")',
        'button:has-text("Next")',
      ]);
      await this.waitForSettled(activePage);
      await this.withStage("label-location-advance", () => this.assertAdvancedPastLabelLocation(activePage));
      await this.withStage("date-time", () => this.fillDateAndTime(activePage, activeRequest));

      const dateTimeCheckpoint = await this.withStage("date-time-checkpoint", () => this.validateCheckpoint(activePage, activeRequest, "date-time", {
        requireBillTo: false,
        requireCharge: true,
      }));
      this.updateAttempt({
        status: "date_time_ready",
        charge: dateTimeCheckpoint.charge,
        artifacts: {
          screenshot: dateTimeCheckpoint.screenshot,
          json: dateTimeCheckpoint.json,
        },
        safeNextCommand: this.safeDryRunCommand(request),
      });

      if (!submit) {
        this.updateAttempt({ stage: "complete", status: "date_time_ready" });
        return {
          success: true,
          mode: "dry-run",
          runId,
          stage: this.activeAttempt.stage,
          submitClicked: false,
          datePolicy: request.datePolicy,
          safeNextCommand: null,
          message: "Filled through Date & Time and stopped before payment/submission.",
          request: this.redactRequest(request),
          checkpoint: this.publicCheckpoint(dateTimeCheckpoint),
          artifacts: {
            screenshot: dateTimeCheckpoint.screenshot,
            json: dateTimeCheckpoint.json,
          },
        };
      }

      const confirmation = await this.submitFromCheckpoint(activePage, activeRequest, dateTimeCheckpoint);
      let calendar: Record<string, unknown> | null = null;
      let calendarError: string | null = null;

      try {
        calendar = await this.withStage("calendar", () => Promise.resolve(this.createCalendarEvent(activeRequest, confirmation.confirmationNumber, confirmation.charge)));
      } catch (error) {
        calendarError = errorMessage(error);
      }

      this.updateAttempt({
        stage: "complete",
        status: calendarError ? "calendar_failed" : "confirmed",
        charge: confirmation.charge,
        confirmationNumber: confirmation.confirmationNumber,
        artifacts: {
          confirmationScreenshot: typeof confirmation.screenshot === "string" ? confirmation.screenshot : null,
        },
        message: calendarError
          ? "UPS collection booked, but calendar creation failed."
          : "UPS collection booked and calendar event created.",
        safeNextCommand: calendarError ? "Recover calendar event only; do not rebook UPS." : null,
        humanUnlock: null,
      });

      return {
        success: true,
        mode: "book",
        runId,
        stage: this.activeAttempt.stage,
        submitClicked: this.activeAttempt.submitClicked,
        datePolicy: request.datePolicy,
        safeNextCommand: this.activeAttempt.safeNextCommand,
        message: calendarError
          ? "UPS collection booked, but calendar creation failed."
          : "UPS collection booked and calendar event created.",
        request: this.redactRequest(request),
        confirmation,
        calendar,
        calendarError,
      };
    } catch (error) {
      const screenshot = page ? await this.captureScreenshot(page, "error") : null;
      if (this.activeAttempt) {
        const postSubmit = this.activeAttempt.submitClicked;
        this.updateAttempt({
          stage: "error",
          status: postSubmit ? "pending_verification" : "pre_submit_failed",
          artifacts: { errorScreenshot: screenshot },
          message: errorMessage(error),
          safeNextCommand: postSubmit ? "npm run cli -- status" : (this.activeAttempt.safeNextCommand ?? (request ? this.safeDryRunCommand(request) : null)),
          humanUnlock: postSubmit
            ? "Verify the UPS account manually or inspect artifacts before any future book attempt for this fingerprint."
            : null,
        });
      }
      return this.failureResult(errorMessage(error), request, screenshot, runId, mode, datePolicy);
    } finally {
      this.releaseAttemptLock();
    }
  }

  private async submitFromCheckpoint(
    page: Page,
    request: ResolvedCollectionRequest,
    dateTimeCheckpoint: Checkpoint,
  ): Promise<Record<string, unknown> & { confirmationNumber: string; charge: string | null }> {
    const dateTimeState = classifyPaymentState(dateTimeCheckpoint.text, dateTimeCheckpoint.charge);
    if (!dateTimeState.charge || !dateTimeCheckpoint.ok) {
      throw new Error("UPS date-time checkpoint was not safe enough to choose payment method.");
    }

    this.updateAttempt({
      stage: "choose-payment",
      status: "date_time_ready",
      submitClicked: false,
      safeNextCommand: this.safeDryRunCommand(request),
      humanUnlock: null,
    });
    await this.clickButton(page, /^Choose Payment Method$/i, [
      'button:has-text("Choose Payment Method")',
      'button:has-text("Payment Method")',
      'button:has-text("Continue")',
    ]);
    this.updateAttempt({
      status: "submit_clicked",
      submitClicked: true,
      safeNextCommand: "npm run cli -- status",
      humanUnlock: "Choose Payment Method can auto-confirm; inspect status/artifacts before any retry.",
    });
    await this.waitForSettled(page);
    await this.dismissCookieBanners(page);

    let afterPaymentText = await this.bodyText(page);
    const autoConfirmation = extractConfirmation(afterPaymentText, dateTimeCheckpoint.charge);
    if (autoConfirmation.confirmed && autoConfirmation.confirmationNumber) {
      const screenshot = await this.captureScreenshot(page, "confirmation");
      return {
        autoConfirmed: true,
        confirmationNumber: autoConfirmation.confirmationNumber,
        charge: autoConfirmation.charge,
        screenshot,
        text: autoConfirmation.text,
      };
    }

    if (/temporarily unavailable|unable to process|service unavailable|try again later/i.test(afterPaymentText)) {
      const screenshot = await this.captureScreenshot(page, "ups-service-error");
      this.updateAttempt({
        status: "pre_submit_failed",
        submitClicked: false,
        artifacts: { payReviewScreenshot: screenshot },
        safeNextCommand: this.safeDryRunCommand(request),
        humanUnlock: null,
      });
      throw new Error(`UPS returned a service error after payment step. Screenshot: ${screenshot}`);
    }

    this.updateAttempt({
      stage: "pay-review-checkpoint",
      status: "payment_step_reached",
      submitClicked: false,
      safeNextCommand: this.safeDryRunCommand(request),
      humanUnlock: null,
    });

    await this.waitForPaymentControls(page);
    await this.dismissCookieBanners(page);
    await this.selectBillToShippingAccountIfNeeded(page);
    await this.waitForPaymentControls(page);
    afterPaymentText = await this.bodyText(page);

    const paymentState = classifyPaymentState(afterPaymentText, dateTimeCheckpoint.charge);
    if (await this.loginEntryPointVisible(page) && !paymentState.billToAccountVisible && !paymentState.explicitAccountFieldsVisible) {
      const screenshot = await this.captureScreenshot(page, "pay-review-auth-required");
      const json = this.writeArtifact("pay-review-auth-required", {
        phase: "pay-review",
        url: page.url(),
        request: this.redactRequest(request),
        state: paymentState,
        text: this.redactCheckpointText(afterPaymentText, request),
        capturedAt: new Date().toISOString(),
      });
      this.updateAttempt({
        status: "pre_submit_failed",
        artifacts: { payReviewScreenshot: screenshot, payReviewJson: json },
        message: "UPS Pay & Review is unauthenticated; header still shows Log In, so Bill To account is unavailable.",
      });
      throw new Error(`UPS Pay & Review is unauthenticated; header still shows Log In and Bill To account is unavailable. Screenshot: ${screenshot}. JSON: ${json}`);
    }

    const payReviewCheckpoint = await this.withStage("pay-review-checkpoint", () => this.validateCheckpoint(page, request, "pay-review", {
      requireBillTo: true,
      requireCharge: true,
    }));
    const reviewPaymentState = classifyPaymentState(
      payReviewCheckpoint.text,
      payReviewCheckpoint.charge ?? dateTimeCheckpoint.charge,
      payReviewCheckpoint.billTo,
    );
    if (reviewPaymentState.state !== "reviewReady") {
      throw new Error(`UPS payment state was ${reviewPaymentState.state}; refusing final Continue without review-ready Bill To and charge evidence.`);
    }

    this.updateAttempt({
      stage: "final-submit",
      status: "submit_clicked",
      submitClicked: true,
      charge: payReviewCheckpoint.charge ?? dateTimeCheckpoint.charge,
      artifacts: {
        payReviewScreenshot: payReviewCheckpoint.screenshot,
        payReviewJson: payReviewCheckpoint.json,
      },
    });
    await this.withStage("final-submit", () => this.clickButton(page, /^Continue$/i, [
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button:has-text("Schedule")',
    ]));
    await this.withStage("confirmation", () => this.waitForSettled(page, 8000));

    const confirmationText = await this.bodyText(page);
    const confirmation = extractConfirmation(confirmationText, payReviewCheckpoint.charge ?? dateTimeCheckpoint.charge);
    const screenshot = await this.captureScreenshot(page, "confirmation");

    if (!confirmation.confirmed || !confirmation.confirmationNumber) {
      throw new Error(`UPS did not show a confirmed collection request number after submit. Screenshot: ${screenshot}`);
    }

    this.updateAttempt({
      status: "confirmed",
      confirmationNumber: confirmation.confirmationNumber,
      charge: confirmation.charge,
      artifacts: { confirmationScreenshot: screenshot },
      safeNextCommand: null,
      humanUnlock: null,
    });

    return {
      autoConfirmed: false,
      confirmationNumber: confirmation.confirmationNumber,
      charge: confirmation.charge,
      screenshot,
      text: confirmation.text,
      preSubmit: this.publicCheckpoint(payReviewCheckpoint),
    };
  }

  private async resolveRequest(options: CollectionOptions, now = new Date()): Promise<ResolvedCollectionRequest> {
    const fallbackDoorCode = options.doorCode || options.skipDoorCode ? null : this.fetchLatestDoorCode();
    return normalizeCollectionOptions(options, fallbackDoorCode, now);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const session = await this.ensureChromeSession();
    this.browser = await chromium.connectOverCDP(session.cdpUrl);
    this.context = this.browser.contexts()[0] ?? await this.browser.newContext();

    const pages = this.context.pages().filter(candidate => !candidate.isClosed());
    this.page = pages[0] ?? await this.context.newPage();
    await this.page.setViewportSize({ width: 1440, height: 1000 }).catch(() => undefined);
    return this.page;
  }

  private async ensureChromeSession(): Promise<CdpSession> {
    const existing = this.readSession();
    if (existing && await this.cdpAlive(existing.port, 750)) {
      return existing;
    }

    if (existsSync(SESSION_PATH)) {
      unlinkSync(SESSION_PATH);
    }

    const port = await findFreePort();
    const cdpUrl = `http://${CDP_HOST}:${port}`;
    const executable = this.findChromeExecutable();
    const child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      UPS_FORM_URL,
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const session: CdpSession = {
      port,
      cdpUrl,
      profileDir: PROFILE_DIR,
      chromePid: child.pid,
      launchedAt: new Date().toISOString(),
    };
    secureWrite(SESSION_PATH, JSON.stringify(session, null, 2));
    await this.waitForCdp(port, 30000);
    return session;
  }

  private readSession(): CdpSession | null {
    if (!existsSync(SESSION_PATH)) return null;
    try {
      return JSON.parse(readFileSync(SESSION_PATH, "utf8")) as CdpSession;
    } catch {
      return null;
    }
  }

  private async cdpAlive(port: number, timeoutMs: number): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`http://${CDP_HOST}:${port}/json/version`, timeoutMs);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForCdp(port: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.cdpAlive(port, 1000)) return;
      await sleep(500);
    }
    throw new Error(`Chrome did not expose CDP on ${CDP_HOST}:${port} within ${timeoutMs}ms.`);
  }

  private findChromeExecutable(): string {
    if (process.env.UPS_CHROME_EXECUTABLE_PATH && existsSync(process.env.UPS_CHROME_EXECUTABLE_PATH)) {
      return process.env.UPS_CHROME_EXECUTABLE_PATH;
    }

    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];

    const found = candidates.find(candidate => existsSync(candidate));
    if (found) return found;

    for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
      try {
        return execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
      }
    }

    throw new Error("Could not find Google Chrome. Set UPS_CHROME_EXECUTABLE_PATH to the Chrome executable.");
  }

  private killChromeProfileProcesses(): void {
    try {
      execFileSync("pkill", ["-f", `user-data-dir=${PROFILE_DIR}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
    }
  }

  private async loginAndOpenForm(page: Page): Promise<void> {
    await page.goto(UPS_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await this.waitForSettled(page);
    await this.dismissCookieBanners(page);

    if (await this.loginEntryPointVisible(page)) {
      await this.openLoginFromHeader(page);
    }

    if (!await this.isFormReady(page) || await this.loginEntryPointVisible(page)) {
      const usernameField = await this.authUsernameField(page, 15000);

      if (usernameField) {
        await this.fillAuthUsername(page, usernameField);
        await this.clickButton(page, /^Continue$/i, [
          'button[type="submit"]',
          'button:has-text("Continue")',
          'button:has-text("Next")',
          'input[type="submit"]',
        ]);
        await this.waitForSettled(page);
        await this.dismissCookieBanners(page);
      } else if (await this.loginEntryPointVisible(page) || /id\.ups\.com|\/lasso\/login/i.test(page.url())) {
        await this.failLoginStep(page, "username", "UPS login did not show an Auth0 username field.");
      }

      const passwordField = await this.passwordFieldAfterUsername(page);

      if (passwordField) {
        await this.fillAuthPassword(page, passwordField);
        await this.clickButton(page, /^(Continue|Log In|Sign In)$/i, [
          'button[type="submit"]',
          'button:has-text("Continue")',
          'button:has-text("Log In")',
          'button:has-text("Sign In")',
          'input[type="submit"]',
        ]);
        await this.waitForSettled(page, 6000);
      } else if (!await this.isFormReady(page)) {
        await this.failLoginStep(page, "password", "UPS login did not show a password field after username submission.");
      }

      await this.handleMfaIfPresent(page);
      await this.confirmProfileIfPresent(page);
      await this.ensureLoginCompleted(page);
    }

    if (/\/us\/en\/error/i.test(page.url())) {
      await page.goto(UPS_FORM_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    } else if (!/pickup|schedule-pickup|wwwapps\.ups\.com/i.test(page.url())) {
      await page.goto(UPS_FORM_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    }

    await this.waitForFormReady(page);
    if (await this.loginEntryPointVisible(page)) {
      const screenshot = await this.captureScreenshot(page, "form-unauthenticated");
      this.updateAttempt({
        safeNextCommand: "npm run cli -- reset-session --clear-profile",
        artifacts: { loginScreenshot: screenshot },
        message: "UPS collection form loaded without an authenticated account session.",
      });
      throw new Error(`UPS collection form loaded without an authenticated account session. Screenshot: ${screenshot}`);
    }
  }

  private async failLoginStep(page: Page, label: string, message: string): Promise<never> {
    const screenshot = await this.captureScreenshot(page, `login-${label}-failed`);
    const json = this.writeArtifact(`login-${label}-failed`, {
      label,
      url: page.url(),
      title: await page.title().catch(() => ""),
      text: normalizeWhitespace(await this.bodyText(page)).slice(0, 2000),
      capturedAt: new Date().toISOString(),
    });
    this.updateAttempt({
      safeNextCommand: "npm run cli -- reset-session --clear-profile",
      artifacts: { loginScreenshot: screenshot, loginJson: json },
      message,
    });
    throw new Error(`${message} Screenshot: ${screenshot}. JSON: ${json}`);
  }

  private async passwordFieldAfterUsername(page: Page): Promise<Locator | null> {
    const passwordField = await this.authPasswordField(page, 20000);
    if (passwordField) return passwordField;

    if (!isUpsUsernameContinueInterstitial(await this.bodyText(page))) return null;
    const usernameField = await this.authUsernameField(page, 1000);
    if (!usernameField) return null;

    await this.fillAuthUsername(page, usernameField);
    await this.clickButton(page, /^Continue$/i, [
      'button[type="submit"]',
      'button[type="submit"]:has-text("Continue")',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ]);

    await this.waitForSettled(page, 6000);
    await this.dismissCookieBanners(page);
    return this.authPasswordField(page, 15000);
  }

  private async authPasswordField(page: Page, timeoutMs: number): Promise<Locator | null> {
    return this.firstVisible(page, [
      'input[type="password"]',
      'input[name="password"]',
      "#password",
      'input[id*="password" i]',
    ], timeoutMs);
  }

  private async openLoginFromHeader(page: Page): Promise<void> {
    const href = await page.locator('a[aria-label="Log In"][href*="/lasso/login"], a[href*="/lasso/login"]:has-text("Log In")')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href) {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 90000 });
      await this.waitForSettled(page, 3000);
      await this.dismissCookieBanners(page);
      return;
    }

    const clicked = await this.clickIfVisible(page, [
      'a[aria-label="Log In"][href*="/lasso/login"]',
      'a[href*="/lasso/login"]:has-text("Log In")',
      'button:has-text("Log In")',
      'a:has-text("Log In")',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
    ]);
    if (clicked) {
      await Promise.race([
        page.waitForURL(/id\.ups\.com|\/lasso\/login/i, { timeout: 10000 }).catch(() => undefined),
        page.waitForTimeout(5000),
      ]);
      await this.waitForSettled(page, 3000);
      await this.dismissCookieBanners(page);
    }
  }

  private async handleMfaIfPresent(page: Page): Promise<void> {
    await this.waitForSettled(page, 2500);
    const text = await this.bodyText(page);
    const title = await page.title().catch(() => "");
    if (!isUpsMfaChallenge({ url: page.url(), title, text })) {
      return;
    }

    await this.dismissCookieBanners(page);
    const clickedAuthenticator = await this.clickAuthenticatorMfaOption(page);
    if (!clickedAuthenticator) {
      const screenshot = await this.captureScreenshot(page, "mfa-no-authenticator-option");
      throw new Error(`UPS asked for MFA but the Authenticator Apps option was not clickable. Screenshot: ${screenshot}`);
    }
    await this.waitForSettled(page, 2000);

    const codeField = await this.firstVisible(page, [
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
      'input[aria-label*="code" i]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[type="text"]',
    ], 15000);

    if (!codeField) {
      const screenshot = await this.captureScreenshot(page, "mfa-no-code-field");
      throw new Error(`UPS asked for MFA but no code field was found. Screenshot: ${screenshot}`);
    }

    const code = generateTotp(this.pass("your-secret-store/ups-billing/totp-secret"));
    await codeField.click({ force: true });
    await codeField.fill("");
    await page.keyboard.type(code, { delay: 30 });
    await this.clickButton(page, /^(Verify|Continue|Submit)$/i, [
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'input[type="submit"]',
    ]);
    await this.waitForSettled(page, 6000);
  }

  private async confirmProfileIfPresent(page: Page): Promise<void> {
    const text = await this.bodyText(page);
    if (!/Welcome Back|verify your current profile information|profile information/i.test(text)) return;

    await this.clickIfVisible(page, [
      'button:has-text("Yes, it is correct")',
      'button:has-text("Yes")',
      'button:has-text("Continue")',
    ]);
    await this.waitForSettled(page, 3000);
    await this.dismissCookieBanners(page);
  }

  private async ensureLoginCompleted(page: Page): Promise<void> {
    await this.waitForSettled(page, 5000);
    const text = await this.bodyText(page);
    if (/id\.ups\.com|\/lasso\/login/i.test(page.url()) || /Email or Username|Forgot Username\/Password|By Continuing, I agree to the UPS Technology Agreement/i.test(text)) {
      await this.failLoginStep(page, "incomplete", "UPS login did not complete before returning to the collection form.");
    }
  }

  private async fillAuthUsername(page: Page, field: Locator): Promise<void> {
    const email = this.pass("your-secret-store/ups-billing/email");
    const attempts = [
      async () => {
        await field.click({ force: true });
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.type(email, { delay: 25 });
      },
      async () => {
        await field.fill("");
        await field.fill(email);
        await field.evaluate(element => {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
    ];

    for (const attempt of attempts) {
      await attempt();
      await page.waitForTimeout(500);
      const value = await field.inputValue().catch(() => "");
      if (value === email) return;
    }

    await this.failLoginStep(page, "username-fill", "UPS login username field did not retain the configured email value.");
  }

  private async fillAuthPassword(page: Page, field: Locator): Promise<void> {
    const password = this.pass("your-secret-store/ups-billing/password");
    const attempts = [
      async () => {
        await field.click({ force: true });
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.type(password, { delay: 35 });
      },
      async () => {
        await field.fill("");
        await field.fill(password);
        await field.evaluate(element => {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
    ];

    for (const attempt of attempts) {
      await attempt();
      await page.waitForTimeout(500);
      const value = await field.inputValue().catch(() => "");
      if (value === password) return;
    }

    await this.failLoginStep(page, "password-fill", "UPS login password field did not retain the configured password value.");
  }

  private async fillLabelAndLocation(page: Page, request: ResolvedCollectionRequest): Promise<void> {
    await this.dismissCookieBanners(page);

    await this.clickIfVisible(page, [
      'label:has-text("A different collection address")',
      'label:has-text("different collection address")',
      'input[type="radio"][value="NEW"]',
    ]);

    const requiredFields = this.requiredLabelAndLocationFields(request);
    for (const field of requiredFields) {
      await this.fillRequired(page, [field.selector], field.value);
    }
    await this.fillOptional(page, ["#inputAddressLine2"], DEFAULTS.address2);
    await this.fillOptional(page, ["#inputAddressLine3"], DEFAULTS.address3);

    await page.waitForTimeout(3000);
    await this.selectDomesticStandardService(page);
    await this.dismissCookieBanners(page);
    await this.waitForSettled(page, 1000);
    await this.restoreFieldsClearedByAccountHydration(page, requiredFields);
  }

  private requiredLabelAndLocationFields(
    request: ResolvedCollectionRequest,
  ): Array<{ name: string; selector: string; value: string }> {
    return [
      { name: "company", selector: "#inputCompanyOrName", value: DEFAULTS.company },
      { name: "contact", selector: "#inputContact", value: DEFAULTS.contact },
      { name: "address1", selector: "#inputAddressLine1", value: DEFAULTS.address1 },
      { name: "city", selector: "#inputCity", value: DEFAULTS.city },
      { name: "postalCode", selector: "#inputZip", value: DEFAULTS.postalCode },
      { name: "phone", selector: "#inputPhoneNo", value: DEFAULTS.phone },
      { name: "email", selector: "#inputEmail", value: DEFAULTS.email },
      { name: "packages", selector: "#inputNoOfPackages", value: String(request.packages) },
      { name: "weight", selector: "#inputWeight", value: String(request.weight) },
    ];
  }

  private async restoreFieldsClearedByAccountHydration(
    page: Page,
    fields: Array<{ name: string; selector: string; value: string }>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = [];
      for (const field of fields) {
        const actual = await page.locator(field.selector).first().inputValue().catch(() => null);
        observed.push({ name: field.name, expected: field.value, actual });
      }

      const cleared = findClearedRequiredFields(observed);
      if (cleared.length === 0) return;

      for (const name of cleared) {
        const field = fields.find(candidate => candidate.name === name);
        if (field) await this.fillRequired(page, [field.selector], field.value);
      }
      await this.waitForSettled(page, 1500);
    }

    const screenshot = await this.captureScreenshot(page, "label-location-fields-unstable");
    console.error(`[ups-field] Label and Location fields still differ after 3 restore passes. Screenshot: ${screenshot}`);
  }

  private async assertAdvancedPastLabelLocation(page: Page): Promise<void> {
    const block = detectLabelLocationBlock(await this.bodyText(page));
    if (!block.blocked) return;

    const screenshot = await this.captureScreenshot(page, "label-location-blocked");
    const detail = block.errors.length > 0 ? ` Fields: ${block.errors.join(", ")}.` : "";
    this.updateAttempt({
      artifacts: { labelLocationScreenshot: screenshot },
      message: `UPS stayed on Label and Location because required fields failed validation.${detail}`,
    });
    throw new Error(
      `UPS stayed on Label and Location because required fields failed validation.${detail} Screenshot: ${screenshot}`,
    );
  }

  private async selectDomesticStandardService(page: Page): Promise<void> {
    await page.locator("#inputDomSrvs3").first().waitFor({ state: "attached", timeout: 8000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const checkbox = page.locator("#inputDomSrvs3").first();
      if (await checkbox.isChecked().catch(() => false)) return;

      await this.setCheckedIfPresent(page, "#inputDomSrvs3", true, false);
      await page.waitForTimeout(750);
      if (await checkbox.isChecked().catch(() => false)) return;

      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>("#inputDomSrvs3");
        if (!input) return;
        input.scrollIntoView({ block: "center", inline: "center" });
        input.click();
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(() => undefined);
      await page.waitForTimeout(1000);
      if (await page.locator("#inputDomSrvs3").first().isChecked().catch(() => false)) return;

      await this.clickIfVisible(page, ['label:has-text("UPS Standard")']);
      await page.waitForTimeout(750);
      if (await page.locator("#inputDomSrvs3").first().isChecked().catch(() => false)) return;
    }

    const screenshot = await this.captureScreenshot(page, "service-standard-not-selected");
    throw new Error(`UPS Standard service checkbox did not stay selected. Screenshot: ${screenshot}`);
  }

  private async fillDateAndTime(page: Page, request: ResolvedCollectionRequest): Promise<void> {
    await this.ensureCollectionDate(page, request.date);

    const earliest = timeParts(request.earliest);
    const latest = timeParts(request.latest);

    await this.chooseDropdownOption(page, "#btn_rtHr", earliest.hour12);
    await this.chooseDropdownOption(page, "#btn_rtMin", earliest.minute);
    await this.setPeriod(page, "ready", earliest.period);

    await this.chooseDropdownOption(page, "#btn_latestPickupTm", latest.hour12);
    await this.chooseDropdownOption(page, "#btn_rtLatestMin", latest.minute);
    await this.setPeriod(page, "latest", latest.period);

    if (await this.locatorExists(page, "#btn_inputPkgLocation")) {
      await this.chooseDropdownOption(page, "#btn_inputPkgLocation", DEFAULTS.parcelLocation, false);
    }

    await this.fillRequired(page, [
      "#inputSpecialInstructions",
      'textarea[name*="instructions" i]',
      'textarea[id*="instruction" i]',
    ], request.specialInstructions);
    await this.waitForSettled(page, 1000);
  }

  private async ensureCollectionDate(page: Page, date: string): Promise<void> {
    if (await this.pageContainsDate(page, date)) return;

    const selectors = [
      "#btn_pickupDate",
      "#btn_collectionDate",
      "#btn_pickupDt",
      'button[id*="date" i]',
      'input[id*="date" i]',
      'select[id*="date" i]',
    ];

    for (const selector of selectors) {
      const control = page.locator(selector).first();
      if (!await this.isVisible(control)) continue;

      const tagName = await control.evaluate("el => el.tagName.toLowerCase()").catch(() => "");
      if (tagName === "input") {
        await control.fill(date).catch(() => undefined);
      } else if (tagName === "select") {
        const selected = await this.selectNativeOptionByText(control, dateTextCandidates(date));
        if (!selected) continue;
      } else {
        await control.click({ force: true });
        await this.waitForSettled(page, 500);
        if (!await this.clickDateOption(page, date)) continue;
      }

      await this.waitForSettled(page, 750);
      if (await this.pageContainsDate(page, date)) return;
    }

    const screenshot = await this.captureScreenshot(page, "date-mismatch");
    throw new Error(`UPS did not offer or display requested collection date ${date}. Screenshot: ${screenshot}`);
  }

  private async validateCheckpoint(
    page: Page,
    request: ResolvedCollectionRequest,
    phase: Checkpoint["phase"],
    options: { requireBillTo: boolean; requireCharge: boolean },
  ): Promise<Checkpoint> {
    const controls = await this.readTimeControls(page);
    const collectionDateText = phase === "date-time"
      ? await this.readCollectionDateControlText(page)
      : await this.readVisibleCollectionSummaryText(page);
    const bodyText = await this.bodyText(page);
    const domSummary = await this.domSummaryText(page, controls, collectionDateText ?? "");
    const validationText = `${bodyText}\n${domSummary}`;
    const billTo = await this.readBillToEvidence(page);
    const validation = validatePreSubmitSummary({
      expected: request,
      text: validationText,
      controls,
      billTo,
    });
    const missing = [...validation.missing];

    if (!this.collectionDateTextMatches(collectionDateText, request.date) && !missing.includes("date")) {
      missing.push("date");
    }
    if (options.requireBillTo && !billToEvidenceReady(billTo) && !missing.includes("billTo")) {
      missing.push("billTo");
    }
    if (options.requireCharge && !validation.charge) {
      missing.push("charge");
    }

    const checkpoint: Checkpoint = {
      ...validation,
      ok: missing.length === 0,
      missing,
      phase,
      screenshot: await this.captureScreenshot(page, `checkpoint-${phase}`),
      json: "",
      text: normalizeWhitespace(validationText).slice(0, 6000),
      billTo,
    };
    checkpoint.json = this.writeArtifact(`checkpoint-${phase}`, {
      phase,
      url: page.url(),
      request: this.redactRequest(request),
      validation: this.publicCheckpoint(checkpoint),
      evidence: this.publicCheckpoint(checkpoint, request),
      capturedAt: new Date().toISOString(),
    });

    if (!checkpoint.ok) {
      const reason = missing.join(", ");
      throw new Error(`UPS pre-submit validation failed at ${phase}: ${reason}. Screenshot: ${checkpoint.screenshot}. JSON: ${checkpoint.json}`);
    }

    return checkpoint;
  }

  private async readTimeControls(page: Page): Promise<ValidationInput["controls"]> {
    const values = await page.evaluate(`(() => {
      const textOrValue = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return "";
        if ("value" in element && element.value) return element.value;
        if (element instanceof HTMLSelectElement && element.selectedOptions[0]) return element.selectedOptions[0].textContent ?? "";
        return element.textContent ?? "";
      };
      const checked = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.checked : undefined;
      };
      const instructions = document.querySelector("#inputSpecialInstructions")?.value ?? "";
      return {
        earliestHour: textOrValue("#btn_rtHr"),
        earliestMin: textOrValue("#btn_rtMin"),
        latestHour: textOrValue("#btn_latestPickupTm"),
        latestMin: textOrValue("#btn_rtLatestMin"),
        earliestPM: checked("#rdReadyTimePM"),
        latestPM: checked("#rdReadyLatestTimePM"),
        instructions,
      };
    })()`) as {
      earliestHour: string;
      earliestMin: string;
      latestHour: string;
      latestMin: string;
      earliestPM?: boolean;
      latestPM?: boolean;
      instructions: string;
    };

    return {
      earliestHour: normalizeControlNumber(values.earliestHour),
      earliestMin: normalizeControlNumber(values.earliestMin),
      latestHour: normalizeControlNumber(values.latestHour),
      latestMin: normalizeControlNumber(values.latestMin),
      earliestPM: values.earliestPM,
      latestPM: values.latestPM,
      instructions: values.instructions,
    };
  }

  private async domSummaryText(
    page: Page,
    controls: ValidationInput["controls"],
    collectionDateText: string,
  ): Promise<string> {
    const values = await page.evaluate(`(() => {
      const value = (selector) => {
        const element = document.querySelector(selector);
        return element?.value ?? "";
      };
      return {
        company: value("#inputCompanyOrName"),
        contact: value("#inputContact"),
        address1: value("#inputAddressLine1"),
        city: value("#inputCity"),
        zip: value("#inputZip"),
        packages: value("#inputNoOfPackages"),
        weight: value("#inputWeight"),
        instructions: value("#inputSpecialInstructions"),
        standard: document.querySelector("#inputDomSrvs3")?.checked ?? false,
        paymentAccount: value("#accountNumber"),
        paymentCountry: value("#country"),
        paymentPostcode: value("#postalCode"),
      };
    })()`) as {
      company: string;
      contact: string;
      address1: string;
      city: string;
      zip: string;
      packages: string;
      weight: string;
      instructions: string;
      standard: boolean;
      paymentAccount: string;
      paymentCountry: string;
      paymentPostcode: string;
    };

    return [
      values.company,
      values.contact,
      [values.address1, values.city, values.zip].filter(Boolean).join(","),
      values.packages ? `Number of Parcels ${values.packages}` : "",
      values.weight ? `Total Weight ${values.weight}` : "",
      collectionDateText ? `Date and Time ${collectionDateText}` : "",
      controlTimeText("Earliest time", controls?.earliestHour, controls?.earliestMin, controls?.earliestPM) ?? "",
      controlTimeText("Latest time", controls?.latestHour, controls?.latestMin, controls?.latestPM) ?? "",
      values.instructions,
      values.standard ? "Services Selected UPS Standard" : "",
      values.paymentAccount ? `Bill To ${values.paymentAccount}` : "",
      values.paymentCountry ? `Bill To Country ${values.paymentCountry}` : "",
      values.paymentPostcode ? `Bill To Postcode ${values.paymentPostcode}` : "",
    ].filter(Boolean).join("\n");
  }

  private createCalendarEvent(
    request: ResolvedCollectionRequest,
    confirmationNumber: string,
    charge: string | null,
  ): Record<string, unknown> {
    const event = buildCalendarEvent({
      confirmationNumber,
      charge,
      date: request.date,
      earliest: request.earliest,
      latest: request.latest,
      packages: request.packages,
      weight: request.weight,
    });

    const output = this.runServiceCli(GOOGLE_WORKSPACE_DIR, [
      "create-event",
      "--summary", event.summary,
      "--start", event.start,
      "--end", event.end,
      "--timezone", event.timezone,
      "--location", event.location,
      "--attendees", event.attendees,
      "--description", event.description,
      "--send-updates", event.sendUpdates,
    ]);

    return {
      event,
      output: parseJson(output) ?? output.trim().slice(0, 2000),
    };
  }

  private fetchLatestDoorCode(): string | null {
    const attempts = [
      {
        method: "channel-history" as const,
        args: ["get-history", "--channel", DOOR_CODE_CHANNEL, "--limit", "10"],
      },
      {
        method: "channel-search" as const,
        args: ["search-messages", "--query", "in:code-YOUR_CITY code", "--limit", "10"],
      },
      {
        method: "phrase-search" as const,
        args: ["search-messages", "--query", "\"door code\" YOUR_CITY", "--limit", "10"],
      },
    ];
    const result = lookupLatestDoorCode(attempts.map(attempt => ({
      method: attempt.method,
      read: () => {
        const output = this.runServiceCli(SLACK_DIR, attempt.args);
        return parseJson(output) ?? output;
      },
    })));

    for (const diagnostic of result.diagnostics) {
      if (diagnostic.status !== "found") {
        console.error(formatDoorCodeLookupDiagnostic(diagnostic));
      }
    }

    return result.code;
  }

  private runServiceCli(cwd: string, args: string[]): string {
    return execFileSync("npm", ["run", "--silent", "cli", "--", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private pass(path: string): string {
    try {
      const value = execFileSync("pass", ["show", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return value.split(/\r?\n/)[0] ?? "";
    } catch {
      throw new Error(`Could not read required UPS secret from pass entry ${path}.`);
    }
  }

  private async dismissCookieBanners(page: Page): Promise<void> {
    await page.evaluate(`(() => {
      const wanted = ["allow all cookies", "essential cookies only", "accept all cookies", "accept cookies"];
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find(candidate => wanted.some(text => candidate.textContent?.toLowerCase().includes(text)));
      button?.click();
      document.querySelectorAll("#onetrust-consent-sdk, .onetrust-pc-dark-filter, #onetrust-banner-sdk")
        .forEach(element => setTimeout(() => element.remove(), 250));
      document.body.style.overflow = "";
    })()`).catch(() => undefined);

    await this.clickIfVisible(page, [
      "#onetrust-accept-btn-handler",
      "#onetrust-reject-all-handler",
      'button:has-text("Allow All Cookies")',
      'button:has-text("Essential Cookies Only")',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("I Agree")',
    ]);
  }

  private async waitForFormReady(page: Page): Promise<void> {
    const candidates = [
      page.locator("#inputCompanyOrName").first().waitFor({ state: "visible", timeout: 30000 }),
      page.getByText("Schedule a One-Time Collection").first().waitFor({ timeout: 30000 }),
      page.getByText("Label and Location").first().waitFor({ timeout: 30000 }),
    ];
    await Promise.any(candidates).catch(async () => {
      const screenshot = await this.captureScreenshot(page, "form-not-ready");
      throw new Error(`UPS collection form did not load. Screenshot: ${screenshot}`);
    });
  }

  private async isFormReady(page: Page): Promise<boolean> {
    if (await this.locatorExists(page, "#inputCompanyOrName")) return true;
    const text = await this.bodyText(page);
    return /Schedule a One-Time Collection|Label and Location/i.test(text);
  }

  private async authUsernameField(page: Page, timeoutMs: number): Promise<Locator | null> {
    const onAuthPage = /id\.ups\.com|\/lasso\/login/i.test(page.url());
    if (!onAuthPage && await this.isFormReady(page)) return null;

    const strict = await this.firstVisible(page, [
      'input[name="username"]',
      "#username",
      'input[name="email"]:not(#inputEmail):not(#inputEmailCheckbox)',
      'input[id*="email" i]:not(#inputEmail):not(#inputEmailCheckbox)',
    ], timeoutMs);
    if (strict) return strict;

    return this.firstVisible(page, ['input[type="email"]'], 1000);
  }

  private async loginEntryPointVisible(page: Page): Promise<boolean> {
    const candidates = [
      page.getByRole("button", { name: /^Log In$/i }).first(),
      page.getByRole("link", { name: /^Log In$/i }).first(),
      page.getByRole("button", { name: /^Sign In$/i }).first(),
      page.getByRole("link", { name: /^Sign In$/i }).first(),
      page.locator('button:has-text("Log In"), a:has-text("Log In"), button:has-text("Sign In"), a:has-text("Sign In")').first(),
    ];

    for (const candidate of candidates) {
      if (await this.isVisible(candidate)) return true;
    }
    return false;
  }

  private async waitForPaymentControls(page: Page): Promise<void> {
    const ready = await page.waitForFunction(
      () => {
        const text = document.body.innerText.replace(/\s+/g, " ");
        return (
          /Thank you for Your Business!.*Collection Request Number:/i.test(text) ||
          /temporarily unavailable|unable to process|service unavailable|try again later|current service is unavailable/i.test(text) ||
          /YOUR_UPS_ACCOUNT_ID/i.test(text) ||
          /UPS Shipping Account Number|Postcode for UPS Account|Bill To Country|Bill To Postcode/i.test(text) ||
          (/Payment Method/i.test(text) && /My UPS Shipping Account/i.test(text))
        );
      },
      undefined,
      { timeout: 30000 },
    ).then(() => true).catch(() => false);

    if (!ready) {
      const screenshot = await this.captureScreenshot(page, "pay-review-payment-controls-timeout");
      throw new Error(`UPS Pay & Review payment controls did not load within 30s. Screenshot: ${screenshot}`);
    }
  }

  private async clickButton(page: Page, name: RegExp, fallbackSelectors: string[]): Promise<void> {
    const roleButton = page.getByRole("button", { name }).first();
    if (await this.isVisible(roleButton)) {
      await roleButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await roleButton.click({ force: true });
      return;
    }

    for (const selector of fallbackSelectors) {
      const locator = page.locator(selector).first();
      if (!await this.isVisible(locator)) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.click({ force: true });
      return;
    }

    throw new Error(`Could not find button matching ${name}.`);
  }

  private async clickIfVisible(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!await this.isVisible(locator)) continue;
      const clicked = await locator.click({ force: true }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
    return false;
  }

  private async clickTextParent(page: Page, text: string): Promise<boolean> {
    const clicked = await page.evaluate(`(() => {
      const targetText = ${JSON.stringify(text)};
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, div, li"));
      const target = candidates.find(element => element.textContent?.trim().includes(targetText));
      target?.click();
      return Boolean(target);
    })()`).catch(() => false);
    return Boolean(clicked);
  }

  private async selectBillToShippingAccountIfNeeded(page: Page): Promise<void> {
    const text = await this.bodyText(page);
    if (!/\bPayment Method\b/i.test(text) || !/\bBill To\b/i.test(text)) return;
    if (billToEvidenceReady(await this.readBillToEvidence(page))) return;
    if (!/My UPS Shipping Account/i.test(text)) return;

    const clicked = await this.clickBillToShippingAccount(page);
    if (!clicked) {
      const screenshot = await this.captureScreenshot(page, "bill-to-account-not-clickable");
      throw new Error(`UPS showed the Bill To account chooser, but My UPS Shipping Account was not clickable. Screenshot: ${screenshot}`);
    }

    await this.fillBillToShippingAccount(page);
    await this.waitForBillToShippingAccountReady(page);
    await this.dismissCookieBanners(page);
    await this.waitForBillToShippingAccountReady(page);
  }

  private async clickBillToShippingAccount(page: Page): Promise<boolean> {
    const radio = page.getByRole("radio", { name: /My UPS Shipping Account/i }).first();
    if (await this.isVisible(radio)) {
      await radio.scrollIntoViewIfNeeded().catch(() => undefined);
      await radio.setChecked(true, { force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await this.billToShippingAccountSelected(page)) return true;
      await radio.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await this.billToShippingAccountSelected(page)) return true;
    }

    const label = page.locator('label:has-text("My UPS Shipping Account")').first();
    if (await this.isVisible(label)) {
      await label.scrollIntoViewIfNeeded().catch(() => undefined);
      await label.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (await this.billToShippingAccountSelected(page)) return true;
    }

    const text = page.getByText(/My UPS Shipping Account/i).first();
    if (await this.isVisible(text)) {
      const box = await text.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(500);
        if (await this.billToShippingAccountSelected(page)) return true;
      }
    }

    const clickedByDom = await page.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll("label, span, div, li, p"))
        .find(element => /My UPS Shipping Account/i.test(element.textContent ?? ""));
      if (!target) return false;

      let node = target;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const radio = node.querySelector?.('input[type="radio"]');
        if (radio instanceof HTMLInputElement) {
          radio.click();
          radio.checked = true;
          radio.dispatchEvent(new Event("input", { bubbles: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }

      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    })()`).catch(() => false);

    if (clickedByDom) {
      await page.waitForTimeout(500);
      return await this.billToShippingAccountSelected(page);
    }

    return false;
  }

  private async billToShippingAccountSelected(page: Page): Promise<boolean> {
    return await this.isVisible(page.locator("#accountNumber").first());
  }

  private async fillBillToShippingAccount(page: Page): Promise<void> {
    await page.locator("#accountNumber").first().waitFor({ state: "visible", timeout: 8000 });

    await this.fillRequired(page, ["#accountNumber"], DEFAULTS.paymentAccountNumber);

    const country = page.locator("#country").first();
    if (await this.locatorExists(page, "#country")) {
      await country.selectOption({ value: DEFAULTS.paymentAccountCountry }).catch(async () => {
        const selected = await this.selectNativeOptionByText(country, ["United Kingdom"]);
        if (!selected) throw new Error("Could not select United Kingdom for UPS Bill To account.");
      });
    }

    if (await this.locatorExists(page, "#postalCode")) {
      await this.fillRequired(page, ["#postalCode"], DEFAULTS.paymentAccountPostcode);
    }
  }

  private async waitForBillToShippingAccountReady(page: Page): Promise<void> {
    const ready = await page.waitForFunction(
      ({ accountNumber, country, postcode }) => {
        const accountCandidate = document.querySelector<HTMLInputElement>("#accountNumber");
        const radios = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        );
        const radiosWithIdentifiers = radios.map((radio) => {
          const labelledBy = radio.getAttribute("aria-labelledby")
            ?.split(/\s+/)
            .map(id => document.getElementById(id)?.textContent)
            .filter(Boolean) ?? [];
          const identifier = [
            radio.value,
            radio.getAttribute("aria-label"),
            ...Array.from(radio.labels ?? []).map(label => label.textContent),
            ...labelledBy,
          ]
            .filter(Boolean)
            .join(" ");
          return { radio, identifier };
        });
        const paymentRadio = radiosWithIdentifiers.find(({ identifier }) => (
          identifier.toUpperCase().includes(accountNumber.toUpperCase())
        ))?.radio ?? radiosWithIdentifiers.find(({ identifier }) => (
          /My UPS Shipping Account/i.test(identifier)
        ))?.radio;
        const billToMode = radiosWithIdentifiers.find(({ radio, identifier }) => (
          radio.checked
          && radio.form !== null
          && getComputedStyle(radio.form).display !== "none"
          && getComputedStyle(radio.form).visibility !== "hidden"
          && radio.form.getClientRects().length > 0
          && (
            (radio.name === "paymentTypeGroup" && /^BillTo$/i.test(radio.value))
            || /^Bill To$/i.test(identifier.trim())
          )
        ))?.radio;
        const savedAccountsMode = radiosWithIdentifiers.find(({ radio, identifier }) => (
          radio.checked
          && radio.form === billToMode?.form
          && (
            (radio.name === "paymentMethodGroup" && radio.value === "N")
            || /\bSaved Accounts\b/i.test(identifier)
          )
        ))?.radio;
        const currentPaymentRoot = billToMode?.closest("form") ?? null;
        const savedAccountSummaries = currentPaymentRoot
          ? Array.from(currentPaymentRoot.querySelectorAll<HTMLElement>("saved-payments .cpc-payment-method-wrapper"))
            .filter((element) => {
              const style = getComputedStyle(element);
              return style.display !== "none"
                && style.visibility !== "hidden"
                && element.getClientRects().length > 0;
            })
          : [];
        const savedAccountSummary = savedAccountSummaries.length === 1
          && savedAccountSummaries[0]?.textContent?.toUpperCase().includes(accountNumber.toUpperCase())
          && /Bill My Account|My UPS Shipping Account/i.test(savedAccountSummaries[0]?.textContent ?? "")
          ? savedAccountSummaries[0]
          : null;
        const currentSavedAccountSelected = Boolean(
          billToMode?.checked
          && savedAccountsMode?.checked
          && savedAccountSummary,
        );
        const scopedPaymentRadio = !currentPaymentRoot || paymentRadio?.form === currentPaymentRoot
          ? paymentRadio
          : undefined;
        const paymentRoot = currentPaymentRoot
          ?? scopedPaymentRadio?.closest("form")
          ?? accountCandidate?.closest("form")
          ?? document;
        const account = paymentRoot.querySelector<HTMLInputElement>("#accountNumber");
        const countrySelect = paymentRoot.querySelector<HTMLSelectElement>("#country");
        const postal = paymentRoot.querySelector<HTMLInputElement>("#postalCode");
        const saved = scopedPaymentRadio?.name
          ? radios.find((radio) => radio.checked
            && radio.name === scopedPaymentRadio.name
            && radio.form === scopedPaymentRadio.form) ?? null
          : scopedPaymentRadio?.checked ? scopedPaymentRadio : null;
        const ariaLabelledBy = saved?.getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent)
          .filter(Boolean) ?? [];
        const savedIdentifier = [
          saved?.value,
          saved?.getAttribute("aria-label"),
          ...Array.from(saved?.labels ?? []).map(label => label.textContent),
          ...ariaLabelledBy,
        ]
          .filter(Boolean)
          .join(" ");
        const continueButton = Array.from(paymentRoot.querySelectorAll("button"))
          .find(button => {
            if (!/^Continue$/i.test(button.textContent?.trim() ?? "")) return false;
            const style = getComputedStyle(button);
            return style.display !== "none"
              && style.visibility !== "hidden"
              && button.getClientRects().length > 0;
          });
        const continueEnabled = Boolean(
          continueButton
          && !continueButton.matches(":disabled")
          && continueButton.getAttribute("aria-disabled") !== "true",
        );
        const explicitFieldsMatch = account?.value === accountNumber &&
          countrySelect?.value === country &&
          postal?.value.replace(/\s+/g, "").toUpperCase() === postcode.replace(/\s+/g, "").toUpperCase();
        const savedAccountMatches = (
          saved?.checked && savedIdentifier.toUpperCase().includes(accountNumber)
        ) || currentSavedAccountSelected;
        return Boolean(continueEnabled && (savedAccountMatches || explicitFieldsMatch));
      },
      {
        accountNumber: DEFAULTS.paymentAccountNumber,
        country: DEFAULTS.paymentAccountCountry,
        postcode: DEFAULTS.paymentAccountPostcode,
      },
      { timeout: 8000 },
    ).then(() => true).catch(() => false);

    if (!ready) {
      const screenshot = await this.captureScreenshot(page, "bill-to-account-not-ready");
      throw new Error(`UPS Bill To account fields were not ready after fill. Screenshot: ${screenshot}`);
    }
  }

  private async readBillToEvidence(page: Page): Promise<BillToEvidence> {
    return await page.evaluate((expectedAccountNumber) => {
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      );
      const radiosWithIdentifiers = radios.map((radio) => {
        const labelledBy = radio.getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent)
          .filter(Boolean) ?? [];
        const identifier = [
          radio.value,
          radio.getAttribute("aria-label"),
          ...Array.from(radio.labels ?? []).map(label => label.textContent),
          ...labelledBy,
        ]
          .filter(Boolean)
          .join(" ");
        return { radio, identifier };
      });
      const paymentRadio = radiosWithIdentifiers.find(({ identifier }) => (
        identifier.toUpperCase().includes(expectedAccountNumber.toUpperCase())
      ))?.radio ?? radiosWithIdentifiers.find(({ identifier }) => (
        /My UPS Shipping Account/i.test(identifier)
      ))?.radio;
      const billToMode = radiosWithIdentifiers.find(({ radio, identifier }) => (
        radio.checked
        && radio.form !== null
        && getComputedStyle(radio.form).display !== "none"
        && getComputedStyle(radio.form).visibility !== "hidden"
        && radio.form.getClientRects().length > 0
        && (
          (radio.name === "paymentTypeGroup" && /^BillTo$/i.test(radio.value))
          || /^Bill To$/i.test(identifier.trim())
        )
      ))?.radio;
      const savedAccountsMode = radiosWithIdentifiers.find(({ radio, identifier }) => (
        radio.checked
        && radio.form === billToMode?.form
        && (
          (radio.name === "paymentMethodGroup" && radio.value === "N")
          || /\bSaved Accounts\b/i.test(identifier)
        )
      ))?.radio;
      const currentPaymentRoot = billToMode?.closest("form") ?? null;
      const savedAccountSummaries = currentPaymentRoot
        ? Array.from(currentPaymentRoot.querySelectorAll<HTMLElement>("saved-payments .cpc-payment-method-wrapper"))
          .filter((element) => {
            const style = getComputedStyle(element);
            return style.display !== "none"
              && style.visibility !== "hidden"
              && element.getClientRects().length > 0;
          })
        : [];
      const savedAccountSummary = savedAccountSummaries.length === 1
        && savedAccountSummaries[0]?.textContent?.toUpperCase().includes(expectedAccountNumber.toUpperCase())
        && /Bill My Account|My UPS Shipping Account/i.test(savedAccountSummaries[0]?.textContent ?? "")
        ? savedAccountSummaries[0]
        : null;
      const currentSavedAccountSelected = Boolean(
        billToMode?.checked
        && savedAccountsMode?.checked
        && savedAccountSummary,
      );
      const accountCandidate = document.querySelector<HTMLInputElement>("#accountNumber");
      const scopedPaymentRadio = !currentPaymentRoot || paymentRadio?.form === currentPaymentRoot
        ? paymentRadio
        : undefined;
      const paymentRoot = currentPaymentRoot
        ?? scopedPaymentRadio?.closest("form")
        ?? accountCandidate?.closest("form")
        ?? document;
      const account = paymentRoot.querySelector<HTMLInputElement>("#accountNumber");
      const country = paymentRoot.querySelector<HTMLSelectElement>("#country");
      const postalCode = paymentRoot.querySelector<HTMLInputElement>("#postalCode");
      const saved = scopedPaymentRadio?.name
        ? radios.find((radio) => radio.checked
          && radio.name === scopedPaymentRadio.name
          && radio.form === scopedPaymentRadio.form) ?? null
        : scopedPaymentRadio?.checked ? scopedPaymentRadio : null;
      const ariaLabelledBy = saved?.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent)
        .filter(Boolean) ?? [];
      const savedAccountIdentifier = [
        saved?.value,
        saved?.getAttribute("aria-label"),
        ...Array.from(saved?.labels ?? []).map(label => label.textContent),
        ...ariaLabelledBy,
      ]
        .filter(Boolean)
        .join(" ");
      const continueButton = Array.from(paymentRoot.querySelectorAll("button"))
        .find(button => {
          if (!/^Continue$/i.test(button.textContent?.trim() ?? "")) return false;
          const style = getComputedStyle(button);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && button.getClientRects().length > 0;
        });
      const continueEnabled = Boolean(
        continueButton
        && !continueButton.matches(":disabled")
        && continueButton.getAttribute("aria-disabled") !== "true",
      );
      return {
        savedAccountChecked: saved?.checked === true || currentSavedAccountSelected,
        savedAccountIdentifier: savedAccountIdentifier || (currentSavedAccountSelected
          ? savedAccountSummary?.textContent?.trim() ?? ""
          : ""),
        accountNumber: account?.value ?? "",
        country: country?.value ?? "",
        postalCode: postalCode?.value ?? "",
        continueEnabled,
      };
    }, DEFAULTS.paymentAccountNumber);
  }

  private async clickAuthenticatorMfaOption(page: Page): Promise<boolean> {
    const selectors = [
      'button[aria-label="Authenticator Apps"]',
      'button:has-text("Authenticator Apps")',
      '[role="button"]:has-text("Authenticator Apps")',
      'a:has-text("Authenticator Apps")',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!await this.isVisible(locator)) continue;

      const attempts = [
        async () => locator.click({ timeout: 5000 }),
        async () => locator.press("Enter", { timeout: 5000 }),
        async () => {
          const box = await locator.boundingBox();
          if (!box) throw new Error("No bounding box for MFA option");
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        },
      ];

      for (const attempt of attempts) {
        await attempt().catch(() => undefined);
        await page.waitForTimeout(1250);
        if (await this.mfaCodeFieldVisible(page) || !await this.mfaChooserVisible(page)) {
          return true;
        }
      }
    }

    if (await this.clickTextParent(page, "Authenticator Apps")) {
      await page.waitForTimeout(1250);
      return await this.mfaCodeFieldVisible(page) || !await this.mfaChooserVisible(page);
    }

    return false;
  }

  private async mfaChooserVisible(page: Page): Promise<boolean> {
    const text = await this.bodyText(page);
    const title = await page.title().catch(() => "");
    return isUpsMfaChallenge({ url: page.url(), title, text }) &&
      !await this.mfaCodeFieldVisible(page);
  }

  private async mfaCodeFieldVisible(page: Page): Promise<boolean> {
    return await this.firstVisible(page, [
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
      'input[aria-label*="code" i]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[type="text"]',
    ], 500) !== null;
  }

  private async firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await this.isVisible(locator)) return locator;
      }
      await page.waitForTimeout(300);
    }
    return null;
  }

  private async fillRequired(page: Page, selectors: string[], value: string): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!await this.locatorExists(page, selector)) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.fill(value, { timeout: 10000 });

      if (await this.fieldHoldsValue(locator, value)) return;

      await locator.fill("").catch(() => undefined);
      await locator.fill(value).catch(() => undefined);
      await locator.evaluate((element, nextValue) => {
        const input = element as HTMLInputElement;
        input.value = nextValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, value).catch(() => undefined);

      if (await this.fieldHoldsValue(locator, value)) return;

      const actual = await locator.inputValue().catch(() => null);
      console.error(`[ups-field] ${selector} holds ${JSON.stringify(actual)} after being set to ${JSON.stringify(value)}`);
      return;
    }
    throw new Error(`Could not find required UPS field: ${selectors.join(", ")}`);
  }

  private async fieldHoldsValue(locator: Locator, value: string): Promise<boolean> {
    await locator.page().waitForTimeout(250);
    const actual = await locator.inputValue().catch(() => null);
    return findClearedRequiredFields([{ name: "field", expected: value, actual }]).length === 0;
  }

  private async fillOptional(page: Page, selectors: string[], value: string): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!await this.locatorExists(page, selector)) continue;
      await locator.fill(value).catch(() => undefined);
      return;
    }
  }

  private async setCheckedIfPresent(page: Page, selector: string, checked: boolean, required = false): Promise<boolean> {
    const locator = page.locator(selector).first();
    if (!await this.locatorExists(page, selector)) {
      if (required) throw new Error(`Could not find required UPS checkbox/radio ${selector}.`);
      return false;
    }

    const alreadyChecked = await locator.isChecked().catch(() => false);
    if (alreadyChecked === checked) return true;

    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.setChecked(checked, { force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    if (await locator.isChecked().catch(() => false) === checked) return true;

    const id = selector.startsWith("#") ? selector.slice(1) : "";
    if (id) {
      await page.locator(`label[for="${id}"]`).first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);
      if (await locator.isChecked().catch(() => false) === checked) return true;
    }

    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(250);
      if (await locator.isChecked().catch(() => false) === checked) return true;
    }

    if (required) throw new Error(`Could not set ${selector} to ${checked}.`);
    return false;
  }

  private async setPeriod(page: Page, group: "ready" | "latest", period: TimePeriod): Promise<void> {
    const selector = group === "ready"
      ? (period === "PM" ? "#rdReadyTimePM" : "#rdReadyTimeAM")
      : (period === "PM" ? "#rdReadyLatestTimePM" : "#rdReadyLatestTimeAM");
    await this.setCheckedIfPresent(page, selector, true, true);
  }

  private async chooseDropdownOption(page: Page, triggerSelector: string, label: string, required = true): Promise<boolean> {
    const trigger = page.locator(triggerSelector).first();
    if (!await this.isVisible(trigger)) {
      if (required) throw new Error(`Could not find UPS dropdown ${triggerSelector}.`);
      return false;
    }

    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click({ force: true });
    await page.waitForTimeout(250);

    const pattern = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i");
    const option = page.getByRole("option", { name: pattern }).first();
    if (await this.isVisible(option)) {
      await option.click({ force: true });
      return true;
    }

    const fallback = page.locator('[role="option"], li, a, button').filter({ hasText: pattern }).first();
    if (await this.isVisible(fallback)) {
      await fallback.click({ force: true });
      return true;
    }

    if (required) throw new Error(`Could not choose option "${label}" from UPS dropdown ${triggerSelector}.`);
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  private async selectNativeOptionByText(locator: Locator, candidates: string[]): Promise<boolean> {
    for (const candidate of candidates) {
      try {
        await locator.selectOption({ label: candidate });
        return true;
      } catch {
      }
    }
    return false;
  }

  private async clickDateOption(page: Page, date: string): Promise<boolean> {
    for (const candidate of dateTextCandidates(date)) {
      const pattern = new RegExp(escapeRegex(candidate), "i");
      const option = page.getByRole("option", { name: pattern }).first();
      if (await this.isVisible(option)) {
        await option.click({ force: true });
        return true;
      }
      const fallback = page.locator('[role="option"], li, a, button').filter({ hasText: pattern }).first();
      if (await this.isVisible(fallback)) {
        await fallback.click({ force: true });
        return true;
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  private async pageContainsDate(page: Page, date: string): Promise<boolean> {
    return this.collectionDateTextMatches(await this.readCollectionDateControlText(page), date);
  }

  private async readCollectionDateControlText(page: Page): Promise<string | null> {
    const readControlText = async (control: Locator, requireCollectionLabel: boolean): Promise<string | null> => {
      if (!await control.isVisible().catch(() => false)) return null;
      if (await control.evaluate(element => element.closest('[hidden], [aria-hidden="true"]') !== null).catch(() => true)) return null;
      if (!await control.isEnabled().catch(() => false)) return null;
      if (await control.getAttribute("aria-disabled") === "true") return null;

      const state = await control.evaluate((element) => {
        const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map(id => document.getElementById(id)?.textContent ?? "");
        const descriptor = [
          element.id,
          element.getAttribute("name") ?? "",
          element.getAttribute("aria-label") ?? "",
          ...Array.from((element as HTMLInputElement | HTMLSelectElement).labels ?? []).map(label => label.textContent ?? ""),
          ...labelledBy,
        ].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");

        if (element instanceof HTMLInputElement) return { descriptor, value: element.value };
        if (element instanceof HTMLSelectElement) {
          const value = [
            element.value,
            ...Array.from(element.selectedOptions).flatMap(option => [option.value, option.label, option.text]),
          ].join(" ");
          return { descriptor, value };
        }
        return {
          descriptor,
          value: [(element as HTMLElement).innerText, element.getAttribute("aria-valuetext") ?? ""].join(" "),
        };
      }).catch(() => ({ descriptor: "", value: "" }));

      if (requireCollectionLabel && !/\b(?:collection|pickup)\s+date\b|\bdate\s+(?:of\s+)?(?:collection|pickup)\b/i.test(state.descriptor)) {
        return null;
      }

      return normalizeWhitespace(state.value);
    };

    for (const selector of ["#btn_pickupDate", "#btn_collectionDate", "#btn_pickupDt"]) {
      const result = await readControlText(page.locator(selector).first(), false);
      if (result !== null) return result;
    }

    const fallbackControls = page.locator("button,input,select");

    for (let index = 0; index < await fallbackControls.count(); index += 1) {
      const result = await readControlText(fallbackControls.nth(index), true);
      if (result !== null) return result;
    }

    return null;
  }

  private async readVisibleCollectionSummaryText(page: Page): Promise<string | null> {
    return await page.evaluate(`(() => {
      const normalize = (value) => value.replace(/\\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
        let current = element;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
            return false;
          }
          current = current.parentElement;
        }
        return element.getClientRects().length > 0;
      };
      const visibleText = (root) => {
        const chunks = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const parent = node.parentElement;
          if (parent && isVisible(parent)) chunks.push(node.textContent ?? "");
          node = walker.nextNode();
        }
        return normalize(chunks.join(" "));
      };
      const hasSummaryFields = (text) => [
        "collection address",
        "number of parcels",
        "total weight",
        "date and time",
        "services selected",
      ].every(marker => text.toLowerCase().includes(marker));

      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],strong,b,div,span,label"))
        .filter(isVisible)
        .filter(element => /^(?:collection\\s+)?summary$/i.test(visibleText(element)));

      for (const heading of headings) {
        let region = heading.parentElement;
        for (let depth = 0; region && depth < 8 && region !== document.body && region !== document.documentElement; depth += 1) {
          const text = visibleText(region);
          if (hasSummaryFields(text)) return text;
          region = region.parentElement;
        }
      }
      return null;
    })()`).catch(() => null) as string | null;
  }

  private collectionDateTextMatches(controlText: string | null, date: string): boolean {
    if (controlText === null) return false;
    return dateTextCandidates(date)
      .map(normalizeWhitespace)
      .some(candidate => new RegExp(`(^|\\D)${escapeRegex(candidate)}(?!\\d)`, "i").test(controlText));
  }

  private async bodyText(page: Page): Promise<string> {
    return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  }

  private async captureScreenshot(page: Page, label: string): Promise<string> {
    const path = join(ARTIFACT_DIR, `ups-${label}-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: true }).catch(() => undefined);
    return path;
  }

  private writeArtifact(label: string, payload: unknown): string {
    const path = join(ARTIFACT_DIR, `ups-${label}-${Date.now()}.json`);
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  }

  private async waitForSettled(page: Page, minimumMs = 3000): Promise<void> {
    await Promise.race([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined),
      page.waitForTimeout(minimumMs),
    ]);
    await page.waitForTimeout(500);
  }

  private async locatorExists(page: Page, selector: string): Promise<boolean> {
    return await page.locator(selector).first().count().catch(() => 0) > 0;
  }

  private async isVisible(locator: Locator): Promise<boolean> {
    return await locator.isVisible().catch(() => false);
  }

  private async withStage<T>(stage: RunStage, task: () => Promise<T>, timeoutMs = STAGE_TIMEOUTS[stage]): Promise<T> {
    this.updateAttempt({ stage });

    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        task(),
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => {
            void this.browser?.close().catch(() => undefined);
            reject(new Error(`UPS stage ${stage} timed out after ${timeoutMs}ms; stopped further browser actions.`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private createAttempt(runId: string, mode: RunMode, fingerprint: string, request: ResolvedCollectionRequest): AttemptManifest {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      runId,
      mode,
      stage: "preflight",
      fingerprint,
      submitClicked: false,
      status: "started",
      createdAt: now,
      updatedAt: now,
      request: this.redactRequest(request),
      datePolicy: request.datePolicy,
      artifacts: {},
      charge: null,
      confirmationNumber: null,
      message: null,
      safeNextCommand: this.safeDryRunCommand(request),
      humanUnlock: null,
    };
  }

  private updateAttempt(patch: Partial<AttemptManifest>): void {
    if (!this.activeAttempt) return;
    this.activeAttempt = {
      ...this.activeAttempt,
      ...patch,
      artifacts: {
        ...this.activeAttempt.artifacts,
        ...(patch.artifacts ?? {}),
      },
      updatedAt: new Date().toISOString(),
    };
    this.writeAttempt(this.activeAttempt);
  }

  private writeAttempt(attempt: AttemptManifest): void {
    mkdirSync(ATTEMPT_DIR, { recursive: true, mode: 0o700 });
    this.atomicWriteJson(this.attemptPath(attempt.runId), attempt);
    this.atomicWriteJson(LATEST_ATTEMPT_PATH, attempt);
  }

  private readAttemptManifests(): AttemptManifest[] {
    if (!existsSync(ATTEMPT_DIR)) return [];
    return readdirSync(ATTEMPT_DIR)
      .filter(name => name.endsWith(".json") && name !== "latest.json")
      .flatMap(name => {
        try {
          const attempt = JSON.parse(readFileSync(join(ATTEMPT_DIR, name), "utf8")) as AttemptManifest;
          return attempt?.schemaVersion === 1 && attempt.runId ? [attempt] : [];
        } catch {
          return [];
        }
      });
  }

  private readLatestAttempt(): AttemptManifest | null {
    if (existsSync(LATEST_ATTEMPT_PATH)) {
      try {
        const attempt = JSON.parse(readFileSync(LATEST_ATTEMPT_PATH, "utf8")) as AttemptManifest;
        if (attempt?.schemaVersion === 1 && attempt.runId) return attempt;
      } catch {
      }
    }

    return this.readAttemptManifests()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  private acquireAttemptLock(fingerprint: string): void {
    const lockPath = this.lockPath(fingerprint);
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "lock.json"), `${JSON.stringify({
        runId: this.activeAttempt?.runId ?? null,
        fingerprint,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      this.activeLockPath = lockPath;
    } catch (error) {
      const reason = error && typeof error === "object" && "code" in error && error.code === "EEXIST"
        ? "another UPS booking process already holds the attempt lock"
        : errorMessage(error);
      throw new Error(`UPS booking blocked: ${reason}. Run npm run cli -- status and inspect attempts before retrying.`);
    }
  }

  private releaseAttemptLock(): void {
    if (!this.activeLockPath) return;
    rmSync(this.activeLockPath, { recursive: true, force: true });
    this.activeLockPath = null;
  }

  private atomicWriteJson(path: string, payload: unknown): void {
    const tmpPath = `${path}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, path);
  }

  private attemptPath(runId: string): string {
    return join(ATTEMPT_DIR, `${runId}.json`);
  }

  private lockPath(fingerprint: string): string {
    return join(ATTEMPT_DIR, `${fingerprintHash(fingerprint)}.lock`);
  }

  private safeDryRunCommand(request: ResolvedCollectionRequest): string {
    return [
      "npm run cli -- dry-run",
      `--date ${request.date}`,
      `--packages ${request.packages}`,
      `--weight ${request.weight}`,
      `--earliest ${request.earliest}`,
      `--latest ${request.latest}`,
      ...(request.doorCode ? [] : ["--skip-door-code"]),
    ].join(" ");
  }

  private blockedResult(runId: string, mode: RunMode, message: string, datePolicy: DatePolicy): Record<string, unknown> {
    return {
      success: false,
      error: true,
      mode,
      runId,
      stage: "preflight",
      submitClicked: false,
      datePolicy,
      safeNextCommand: datePolicy.safeNextCommand,
      message,
    };
  }

  private failureResult(
    message: string,
    request: ResolvedCollectionRequest | null,
    screenshot: string | null,
    runId: string | null = null,
    mode: RunMode | null = null,
    datePolicy: DatePolicy | null = null,
  ): Record<string, unknown> {
    const attempt = this.activeAttempt;
    return {
      success: false,
      error: true,
      mode: attempt?.mode ?? mode,
      runId: attempt?.runId ?? runId,
      stage: attempt?.stage ?? "error",
      submitClicked: attempt?.submitClicked ?? false,
      status: attempt?.status ?? "failed",
      datePolicy: attempt?.datePolicy ?? request?.datePolicy ?? datePolicy,
      safeNextCommand: attempt?.safeNextCommand ?? (request ? this.safeDryRunCommand(request) : null),
      message,
      request: request ? this.redactRequest(request) : null,
      screenshot,
      attemptPath: attempt ? this.attemptPath(attempt.runId) : null,
    };
  }

  private redactRequest(request: ResolvedCollectionRequest): Record<string, unknown> {
    const maskedDoorCode = request.doorCode ? maskDoorCode(request.doorCode) : null;
    return {
      date: request.date,
      earliest: request.earliest,
      latest: request.latest,
      packages: request.packages,
      weight: request.weight,
      doorCode: maskedDoorCode,
      specialInstructions: request.doorCode
        ? request.specialInstructions.replace(request.doorCode, maskedDoorCode ?? "")
        : request.specialInstructions,
    };
  }

  private publicCheckpoint(checkpoint: Checkpoint, request?: ResolvedCollectionRequest): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ok: checkpoint.ok,
      phase: checkpoint.phase,
      missing: checkpoint.missing,
      charge: checkpoint.charge,
      screenshot: checkpoint.screenshot,
      json: checkpoint.json,
    };
    if (request) {
      result.text = this.redactCheckpointText(checkpoint.text, request);
    }
    return result;
  }

  private redactCheckpointText(text: string, request: ResolvedCollectionRequest): string {
    let redacted = normalizeWhitespace(text);
    if (request.doorCode) {
      const maskedDoorCode = maskDoorCode(request.doorCode);
      redacted = redacted
        .replaceAll(request.doorCode, maskedDoorCode)
        .replaceAll(request.specialInstructions, request.specialInstructions.replace(request.doorCode, maskedDoorCode));
    }
    return redacted
      .replaceAll(DEFAULTS.email, "log***@your-company.com")
      .replaceAll(DEFAULTS.phone, "REDACTED_PHONE")
      .slice(0, 6000);
  }
}

function timeParts(time: string): { hour12: string; minute: string; period: TimePeriod } {
  const [hourRaw, minute = "00"] = time.split(":");
  const hour24 = Number(hourRaw);
  return {
    hour12: String(((hour24 + 11) % 12) + 1).padStart(2, "0"),
    minute,
    period: hour24 >= 12 ? "PM" : "AM",
  };
}

function normalizeControlNumber(value: string | undefined): string | undefined {
  const match = value?.match(/\d{1,2}/);
  return match ? match[0].padStart(2, "0") : undefined;
}

function controlTimeText(label: string, hour: string | undefined, minute: string | undefined, isPm: boolean | undefined): string | null {
  if (!hour || !minute || isPm === undefined) return null;
  return `${label} ${Number(hour)}:${minute} ${isPm ? "PM" : "AM"}`;
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function maskDoorCode(code: string): string {
  return `${code.slice(0, 3)}***${code.slice(-3)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

function fingerprintHash(fingerprint: string): string {
  return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, CDP_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
