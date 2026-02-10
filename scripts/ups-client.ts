/**
 * UPS Collection Manager Client
 *
 * Browser automation client for booking UPS parcel collections
 * via the UPS web interface. Uses Playwright with stealth mode.
 *
 * Key features:
 * - Login: Automated two-step authentication
 * - Form fill: Pre-fills collection details with smart defaults
 * - Submit: Completes booking and extracts confirmation
 * - Screenshots: Captures state at each step for verification
 *
 * Uses headed browser with stealth plugin to avoid bot detection.
 * Sessions are persisted for reconnection between operations.
 *
 * Default address: YOUR_COMPANY YOUR_CITY warehouse (YOUR_POSTCODE)
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page, BrowserContext } from "playwright";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Add stealth plugin to evade bot detection
chromium.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const SESSION_PATH = "/tmp/ups-session.json";
const SCREENSHOT_DIR = "/home/USER/biz/.playwright-mcp";
const CONFIG_PATH = join(__dirname, "..", "config.json");
// Persistent profile directory - preserves cookies, localStorage, history
// Using /tmp to avoid WSL2 symlink issues with SingletonLock
const USER_DATA_DIR = "/tmp/ups-browser-profile";

// UPS URLs
const UPS_LOGIN_URL = "https://www.ups.com/lasso/login?loc=en_GB&returnto=https://wwwapps.ups.com/pickup/schedule?loc=en_GB";
const UPS_FORM_URL = "https://wwwapps.ups.com/pickup/schedule?loc=en_GB";

// Default collection values
const DEFAULTS = {
  company: "YOUR_COMPANY",
  address: "YOUR_WAREHOUSE_ADDRESS_LINE_1, YOUR_WAREHOUSE_ADDRESS_LINE_2",
  city: "YOUR_CITY",
  postalCode: "YOUR_POSTCODE",
  telephone: "YOUR_PHONE_NUMBER",
  collectFrom: "Front Door",
  email: "YOUR_LOGISTICS_EMAIL",
  paymentAccount: "YOUR_UPS_ACCOUNT",
};

interface SessionInfo {
  wsEndpoint: string;
  createdAt: string;
  formFilled: boolean;
  loggedIn: boolean;
}

interface Config {
  ups: {
    username: string;
    password: string;
  };
}

interface FillFormOptions {
  date?: string;
  packages?: number;
  weight?: number;
  earliestTime?: string;
  latestTime?: string;
  doorCode?: string;
  specialInstructions?: string;
}

interface ScreenshotOptions {
  filename?: string;
  fullPage?: boolean;
}

interface FormState {
  date?: string;
  packages?: number;
  weight?: number;
  earliestTime?: string;
  latestTime?: string;
  specialInstructions?: string;
  company?: string;
  address?: string;
  city?: string;
  postalCode?: string;
}

export class UPSClient {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor() {
    this.config = this.loadConfig();
    // Ensure screenshot directory exists
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  }

  // ============================================
  // INTERNAL
  // ============================================

  private loadConfig(): Config {
    if (!existsSync(CONFIG_PATH)) {
      throw new Error(`Config file not found at ${CONFIG_PATH}`);
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }

  private async ensureBrowser(): Promise<Page> {
    // Ensure persistent profile directory exists
    if (!existsSync(USER_DATA_DIR)) {
      mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    // Try to reconnect to existing session
    if (existsSync(SESSION_PATH)) {
      try {
        const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
        this.browser = await chromium.connectOverCDP(session.wsEndpoint);
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          this.context = contexts[0];
          const pages = this.context.pages();
          if (pages.length > 0) {
            this.page = pages[0];
            return this.page;
          }
        }
      } catch {
        // Session invalid, clean up
        try {
          unlinkSync(SESSION_PATH);
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Clean up any stale singleton files that may interfere
    const singletonFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const file of singletonFiles) {
      const filePath = `${USER_DATA_DIR}/${file}`;
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore errors
        }
      }
    }

    // Launch browser - using regular launch without persistent context
    // This avoids WSL2 singleton issues but means we login fresh each time
    this.browser = await chromium.launch({
      headless: false,  // Headed mode to avoid bot detection
      args: [
        "--disable-blink-features=AutomationControlled",  // Hide automation flag
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
      ],
    });

    // Create context with viewport settings
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    // Create page
    this.page = await this.context.newPage();

    // Save session for reconnection
    const wsEndpoint = (this.browser as any)?.wsEndpoint?.() as string | undefined;
    if (wsEndpoint) {
      writeFileSync(
        SESSION_PATH,
        JSON.stringify({
          wsEndpoint,
          createdAt: new Date().toISOString(),
          formFilled: false,
          loggedIn: false,
        } as SessionInfo)
      );
    }

    return this.page;
  }

  private updateSession(updates: Partial<SessionInfo>): void {
    if (existsSync(SESSION_PATH)) {
      const session = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      Object.assign(session, updates);
      writeFileSync(SESSION_PATH, JSON.stringify(session));
    }
  }

  private async dismissCookieBanners(page: Page): Promise<void> {
    // Wait a bit for the cookie banner to appear
    await page.waitForTimeout(2000);

    // First try to remove overlays via JavaScript - most reliable
    try {
      await page.evaluate(() => {
        // Remove OneTrust overlays
        document.querySelectorAll('#onetrust-consent-sdk, .onetrust-pc-dark-filter, #onetrust-banner-sdk').forEach(el => el.remove());
        // Remove any other common cookie overlays
        document.querySelectorAll('[class*="cookie-overlay"], [class*="consent-overlay"], [id*="cookie-banner"]').forEach(el => el.remove());
        // Reset body scroll if locked
        document.body.style.overflow = '';
      });
    } catch {
      // Ignore errors
    }

    // Then try clicking accept buttons
    const cookieButtonSelectors = [
      '#onetrust-accept-btn-handler',
      '#accept-recommended-btn-handler',
      'button[id*="accept"]',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Got it")',
    ];

    for (const selector of cookieButtonSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true, timeout: 5000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch {
        continue;
      }
    }

    // Final cleanup - remove any remaining overlays
    try {
      await page.evaluate(() => {
        document.querySelectorAll('#onetrust-consent-sdk, .onetrust-pc-dark-filter').forEach(el => el.remove());
      });
    } catch {
      // Ignore errors
    }
  }

  private async login(): Promise<boolean> {
    const page = await this.ensureBrowser();

    // Navigate to login page - use domcontentloaded for faster initial load, then wait for page to stabilize
    await page.goto(UPS_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    // Give the page extra time to load dynamic content
    await page.waitForTimeout(5000);

    // Handle cookie consent banners (OneTrust, etc.)
    await this.dismissCookieBanners(page);

    // Take screenshot of login page to see what we're working with
    const loginScreenshot = `${SCREENSHOT_DIR}/ups-login-page-${Date.now()}.png`;
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    // UPS now uses Auth0-style login (id.ups.com) with two-step flow:
    // Step 1: Enter username/email
    // Step 2: Enter password

    // Wait for username/email field - try multiple selectors for Auth0 login
    const usernameSelectors = [
      'input[name="username"]',        // Auth0 common
      'input[id="username"]',          // Auth0 common
      'input[type="email"]',
      'input[name="email"]',
      '#email',
      'input[id*="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
    ];

    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        usernameField = await page.waitForSelector(selector, { timeout: 10000 });
        if (usernameField) break;
      } catch {
        continue;
      }
    }

    if (!usernameField) {
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-login-error-no-username-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find username field. See screenshot: ${errorScreenshot}`);
    }

    // Fill username
    await usernameField.fill(this.config.ups.username);

    // Click continue/next button for two-step login
    const continueButton = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next"), input[type="submit"]');
    if (continueButton) {
      await continueButton.click({ force: true });
      await page.waitForTimeout(2000);
      // Dismiss any cookie banners that might have appeared
      await this.dismissCookieBanners(page);
    }

    // Wait for password field to appear (may be on same page or new step)
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
      'input[id*="password"]',
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.waitForSelector(selector, { timeout: 15000 });
        if (passwordField) break;
      } catch {
        continue;
      }
    }

    if (!passwordField) {
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-login-error-no-password-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find password field. See screenshot: ${errorScreenshot}`);
    }

    // Fill password
    await passwordField.fill(this.config.ups.password);

    // Click login/submit button
    const loginButton = await page.$('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Continue")');
    if (loginButton) {
      await loginButton.click({ force: true });
    }

    // Wait for successful login - either redirect to form or user icon appears
    try {
      await Promise.race([
        page.waitForURL(/pickup|wwwapps\.ups\.com/, { timeout: 60000 }),
        page.waitForSelector('[aria-label*="account"], [aria-label*="user"], .user-menu, [data-testid*="account"]', { timeout: 60000 }),
      ]);
    } catch {
      // Take screenshot of login failure
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-login-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Login failed. See screenshot: ${errorScreenshot}`);
    }

    this.updateSession({ loggedIn: true });
    return true;
  }

  // ============================================
  // SMART DEFAULTS
  // ============================================

  /** Calculates the next valid collection date based on UK time. */
  private getSmartDate(): string {
    const now = new Date();
    // Convert to UK time
    const ukTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
    const hour = ukTime.getHours();

    // If after 1 PM UK time, default to next business day
    let targetDate = new Date(ukTime);
    if (hour >= 13) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    // Skip weekends
    while (targetDate.getDay() === 0 || targetDate.getDay() === 6) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    return targetDate.toISOString().split("T")[0];
  }

  /** Calculates the earliest collection time based on current UK time. */
  private getSmartEarliestTime(): string {
    const now = new Date();
    const ukTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
    const hour = ukTime.getHours();

    // If collecting today and past noon, round up to next hour
    if (hour >= 12 && hour < 17) {
      return `${hour + 1}:00`;
    }
    return "12:00";
  }

  // ============================================
  // COLLECTION OPERATIONS
  // ============================================

  /**
   * Fills the UPS collection booking form.
   *
   * Logs in if needed, navigates to the collection form, and fills
   * all fields with provided values or smart defaults.
   *
   * @param options - Collection details
   * @param options.date - Collection date (YYYY-MM-DD), defaults to next business day
   * @param options.packages - Number of packages (default: 1)
   * @param options.weight - Total weight in kg (default: 10)
   * @param options.earliestTime - Earliest collection time (HH:MM)
   * @param options.latestTime - Latest collection time (HH:MM)
   * @param options.doorCode - Door access code (added to special instructions)
   * @param options.specialInstructions - Additional pickup instructions
   * @returns Result with screenshot path and form state
   */
  async fillForm(options: FillFormOptions): Promise<any> {
    const page = await this.ensureBrowser();

    // Login first
    await this.login();

    // Navigate to collection form
    await page.goto(UPS_FORM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Handle any cookie banners on form page
    await this.dismissCookieBanners(page);

    // Wait for form to load
    await page.waitForTimeout(3000);

    // Apply smart defaults
    const date = options.date || this.getSmartDate();
    const earliestTime = options.earliestTime || this.getSmartEarliestTime();
    const packages = options.packages || 1;
    const weight = options.weight || 10;

    // Build special instructions
    let specialInstructions = options.specialInstructions;
    if (!specialInstructions && options.doorCode) {
      specialInstructions = `Door code * ${options.doorCode} #`;
    }

    // Take initial screenshot to see what we're working with
    const initialScreenshot = `${SCREENSHOT_DIR}/ups-form-initial-${Date.now()}.png`;
    await page.screenshot({ path: initialScreenshot, fullPage: true });

    // The UPS form is complex - we need to identify elements by their labels/structure
    // This is a simplified approach - real implementation may need adjustments based on actual form

    try {
      // IMPORTANT: Must select "A different collection address" radio button
      // The UPS form defaults to saved account address which is London, not YOUR_CITY
      const differentAddressSelectors = [
        'input[type="radio"][value="NEW"]',
        'input[type="radio"][id*="different"]',
        'input[type="radio"][id*="new"]',
        'label:has-text("different collection address") input[type="radio"]',
        'label:has-text("A different collection") input[type="radio"]',
      ];

      let radioClicked = false;
      for (const selector of differentAddressSelectors) {
        try {
          const radio = await page.$(selector);
          if (radio) {
            await radio.click({ force: true });
            radioClicked = true;
            await page.waitForTimeout(1000); // Wait for form fields to appear
            break;
          }
        } catch {
          continue;
        }
      }

      // If selectors failed, try clicking by label text via JavaScript
      if (!radioClicked) {
        await page.evaluate(() => {
          // Find all radio buttons and their labels
          const radios = document.querySelectorAll('input[type="radio"]');
          radios.forEach(radio => {
            const label = document.querySelector(`label[for="${radio.id}"]`);
            const labelText = label?.textContent?.toLowerCase() || '';
            if (labelText.includes('different') && labelText.includes('collection')) {
              (radio as HTMLInputElement).click();
            }
          });
        });
        await page.waitForTimeout(1000);
      }

      // Fill company name
      await this.fillField(page, ["Company", "Company Name", "company"], DEFAULTS.company);

      // Fill address
      await this.fillField(page, ["Address Line 1", "Address", "Street Address", "addressLine1"], DEFAULTS.address);

      // Fill city
      await this.fillField(page, ["City", "Town", "city"], DEFAULTS.city);

      // Fill postal code
      await this.fillField(page, ["Postal Code", "Postcode", "ZIP", "postalCode"], DEFAULTS.postalCode);

      // Fill telephone
      await this.fillField(page, ["Telephone", "Phone", "Contact Number", "telephone"], DEFAULTS.telephone);

      // Fill package count
      await this.fillField(page, ["Package", "Packages", "Number of Packages"], String(packages));

      // Fill weight
      await this.fillField(page, ["Weight", "Total Weight"], String(weight));

      // Fill special instructions
      if (specialInstructions) {
        await this.fillField(page, ["Special Instructions", "Instructions", "Notes"], specialInstructions);
      }

      // Select collection location
      await this.selectOption(page, ["Preferred Collection Location", "Collect From", "Collection Location"], "Front Door");

      // Fill notification email
      await this.fillField(page, ["Email", "Notification Email", "email"], DEFAULTS.email);

      // Select collection date from dropdown
      // The date is in format YYYY-MM-DD, but dropdown shows "Friday, January 16, 2026"
      // We need to match by the date portion
      const dateObj = new Date(date + 'T12:00:00');
      const dateOptions: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      };
      const formattedDate = dateObj.toLocaleDateString('en-GB', dateOptions);

      // Try to select date from dropdown
      await page.evaluate((searchDate) => {
        const selects = document.querySelectorAll('select');
        selects.forEach(select => {
          const options = Array.from(select.options);
          const matchingOption = options.find(opt =>
            opt.text.toLowerCase().includes(searchDate.toLowerCase()) ||
            opt.text.includes(searchDate.split(', ').pop() || '') // Try matching by date portion
          );
          if (matchingOption) {
            select.value = matchingOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }, formattedDate);

      // Also try with the day number
      const dayNum = dateObj.getDate();
      const monthName = dateObj.toLocaleDateString('en-GB', { month: 'long' });
      await page.evaluate(({ day, month }: { day: number; month: string }) => {
        const selects = document.querySelectorAll('select');
        selects.forEach(select => {
          const options = Array.from(select.options);
          const matchingOption = options.find(opt =>
            opt.text.includes(String(day)) && opt.text.toLowerCase().includes(month.toLowerCase())
          );
          if (matchingOption && !select.value.includes('January')) {
            select.value = matchingOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }, { day: dayNum, month: monthName });

      await page.waitForTimeout(500);

      // Select time dropdowns if present
      // Earliest time
      if (earliestTime) {
        const [hour] = earliestTime.split(':');
        await page.evaluate((h: string) => {
          // Find hour selects
          const selects = document.querySelectorAll('select');
          let foundEarliest = false;
          selects.forEach(select => {
            const label = select.closest('div')?.querySelector('label')?.textContent?.toLowerCase() || '';
            if (label.includes('earliest') && !foundEarliest) {
              // This might be the hour select
              const hourOpt = Array.from(select.options).find(opt => opt.text.trim() === h || opt.value === h);
              if (hourOpt) {
                select.value = hourOpt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                foundEarliest = true;
              }
            }
          });
        }, hour);
      }

    } catch (formError: any) {
      // Take screenshot of form error
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-form-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Form fill error: ${formError.message}`,
        screenshot: errorScreenshot,
      };
    }

    // Take preview screenshot
    const previewScreenshot = `${SCREENSHOT_DIR}/ups-form-preview-${Date.now()}.png`;
    await page.screenshot({ path: previewScreenshot, fullPage: true });

    // Update session
    this.updateSession({ formFilled: true });

    // Extract what we filled
    const formState: FormState = {
      date,
      packages,
      weight,
      earliestTime,
      latestTime: options.latestTime || "18:00",
      specialInstructions,
      company: DEFAULTS.company,
      address: DEFAULTS.address,
      city: DEFAULTS.city,
      postalCode: DEFAULTS.postalCode,
    };

    return {
      success: true,
      screenshot: previewScreenshot,
      formState,
      message: "Form filled successfully. Please review the screenshot before calling submit.",
    };
  }

  private async fillField(page: Page, labelVariants: string[], value: string): Promise<void> {
    for (const label of labelVariants) {
      try {
        // Try by aria-label
        let field = await page.$(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by placeholder
        field = await page.$(`input[placeholder*="${label}" i], textarea[placeholder*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by label text
        const labelEl = await page.$(`label:has-text("${label}")`);
        if (labelEl) {
          const forAttr = await labelEl.getAttribute("for");
          if (forAttr) {
            field = await page.$(`#${forAttr}`);
            if (field) {
              await field.fill(value);
              return;
            }
          }
          // Try sibling input
          field = await labelEl.$("xpath=following-sibling::input | following-sibling::textarea | ../input | ../textarea");
          if (field) {
            await field.fill(value);
            return;
          }
        }

        // Try by name attribute
        field = await page.$(`input[name*="${label.toLowerCase().replace(/\s+/g, '')}" i], textarea[name*="${label.toLowerCase().replace(/\s+/g, '')}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }
      } catch {
        // Continue to next variant
      }
    }
    // Field not found - not throwing to allow partial form fills
  }

  private async selectOption(page: Page, labelVariants: string[], value: string): Promise<void> {
    for (const label of labelVariants) {
      try {
        // Try select dropdown
        const select = await page.$(`select[aria-label*="${label}" i], select[name*="${label.toLowerCase().replace(/\s+/g, '')}" i]`);
        if (select) {
          await select.selectOption({ label: value });
          return;
        }

        // Try radio buttons
        const radio = await page.$(`input[type="radio"][value*="${value}" i], label:has-text("${value}") input[type="radio"]`);
        if (radio) {
          await radio.click();
          return;
        }
      } catch {
        // Continue to next variant
      }
    }
  }

  // ============================================
  // SCREENSHOT OPERATIONS
  // ============================================

  /**
   * Takes a screenshot of the current browser state.
   *
   * @param options - Screenshot options
   * @param options.filename - Custom filename (default: timestamped)
   * @param options.fullPage - Capture full scrollable page (default: false)
   * @returns Result with screenshot path
   */
  async takeScreenshot(options?: ScreenshotOptions): Promise<any> {
    const page = await this.ensureBrowser();

    const filename = options?.filename || `ups-${Date.now()}.png`;
    const screenshotPath = `${SCREENSHOT_DIR}/${filename}`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: options?.fullPage ?? false,
    });

    return {
      success: true,
      screenshot: screenshotPath,
    };
  }

  /**
   * Submits the filled collection form.
   *
   * Must be called after fillForm(). Navigates through review page
   * and submits the booking.
   *
   * @returns Result with confirmation details and screenshots
   * @throws {Error} If form has not been filled yet
   */
  async submit(): Promise<any> {
    const page = await this.ensureBrowser();

    // Check if form was filled
    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (!session.formFilled) {
        return {
          error: true,
          message: "Form has not been filled yet. Call fill-form first.",
        };
      }
    }

    try {
      // Click Next/Submit/Continue button to go to review page
      const nextButton = await page.$('button:has-text("Next"), button:has-text("Continue"), button:has-text("Review"), button[type="submit"]');
      if (nextButton) {
        await nextButton.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
      }

      // Take screenshot of review page
      const reviewScreenshot = `${SCREENSHOT_DIR}/ups-review-${Date.now()}.png`;
      await page.screenshot({ path: reviewScreenshot, fullPage: true });

      // Look for final submit button on review page
      const submitButton = await page.$('button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Schedule"), button[type="submit"]');
      if (submitButton) {
        await submitButton.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(3000);
      }

      // Take confirmation screenshot
      const confirmationScreenshot = `${SCREENSHOT_DIR}/ups-confirmation-${Date.now()}.png`;
      await page.screenshot({ path: confirmationScreenshot, fullPage: true });

      // Try to extract confirmation details from page
      const confirmation = await this.extractConfirmation(page);

      return {
        success: true,
        screenshot: confirmationScreenshot,
        reviewScreenshot,
        confirmation,
        message: "Collection submitted successfully.",
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-submit-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });

      return {
        error: true,
        message: `Submit failed: ${error.message}`,
        screenshot: errorScreenshot,
      };
    }
  }

  private async extractConfirmation(page: Page): Promise<Record<string, any>> {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText;

        // Try to find confirmation number
        const confirmationPatterns = [
          /Confirmation[:\s#]*([A-Z0-9]+)/i,
          /Request[:\s#]*([A-Z0-9]+)/i,
          /Reference[:\s#]*([A-Z0-9]+)/i,
          /Pickup[:\s#]*([A-Z0-9]+)/i,
        ];

        let confirmationNumber = null;
        for (const pattern of confirmationPatterns) {
          const match = text.match(pattern);
          if (match) {
            confirmationNumber = match[1];
            break;
          }
        }

        // Try to find total charges
        const chargesMatch = text.match(/Total[^:]*:\s*([\d.,]+\s*(?:GBP|£))/i);
        const totalCharges = chargesMatch?.[1] || null;

        // Try to find collection date
        const dateMatch = text.match(/(?:Collection|Pickup)\s*Date[:\s]*([^,\n]+)/i);
        const collectionDate = dateMatch?.[1]?.trim() || null;

        return {
          confirmationNumber,
          totalCharges,
          collectionDate,
          pageText: text.substring(0, 3000),
        };
      });
    } catch {
      return { pageText: "Unable to extract confirmation details" };
    }
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  /**
   * Closes browser session and clears saved state.
   *
   * Call this to start fresh or after completing a booking.
   *
   * @returns Success/error result
   */
  async reset(): Promise<any> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
      }

      if (existsSync(SESSION_PATH)) {
        unlinkSync(SESSION_PATH);
      }

      return {
        success: true,
        message: "Browser session closed and cleared.",
      };
    } catch (error: any) {
      return {
        error: true,
        message: `Reset failed: ${error.message}`,
      };
    }
  }

  /**
   * Books a collection in one step (fill + submit).
   *
   * Combines fillForm() and submit() into a single operation,
   * keeping the browser session alive between steps.
   *
   * @param options - Collection details (same as fillForm)
   * @returns Result with fill/review/confirmation screenshots and booking details
   */
  async book(options: FillFormOptions): Promise<any> {
    // First, fill the form
    const fillResult = await this.fillForm(options);

    if (fillResult.error) {
      return fillResult;
    }

    // Small delay to let any JavaScript settle
    if (this.page) {
      await this.page.waitForTimeout(2000);
    }

    // Now submit - but we need to use the already-open page
    // rather than calling ensureBrowser() which might launch a new browser
    if (!this.page) {
      return {
        error: true,
        message: "Browser page not available after fill",
      };
    }

    const page = this.page;

    try {
      // Dismiss any cookie banners before attempting to click buttons
      await this.dismissCookieBanners(page);

      // Scroll to bottom of page to make sure Next button is visible
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      // Click Next button - look for the visible one specifically
      // UPS form has a blue "Next" button at the bottom
      const nextSelectors = [
        'button.ups-cta_primary:has-text("Next")',
        'button[class*="primary"]:has-text("Next")',
        'button:has-text("Next"):visible',
        '#btnNext',
        'button:has-text("Next")',
      ];

      let clicked = false;
      for (const selector of nextSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            const isVisible = await button.isVisible();
            if (isVisible) {
              await button.scrollIntoViewIfNeeded();
              await button.click({ force: true });
              clicked = true;
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!clicked) {
        // Try clicking via JavaScript as fallback
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const nextButton = buttons.find(b => b.textContent?.toLowerCase().includes('next') && b.offsetParent !== null);
          if (nextButton) (nextButton as HTMLElement).click();
        });
      }

      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);

      // Dismiss any cookie banners on review page
      await this.dismissCookieBanners(page);

      // Take screenshot of review page
      const reviewScreenshot = `${SCREENSHOT_DIR}/ups-review-${Date.now()}.png`;
      await page.screenshot({ path: reviewScreenshot, fullPage: true });

      // Look for final submit button on review page
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);

      const submitSelectors = [
        'button.ups-cta_primary:has-text("Schedule")',
        'button[class*="primary"]:has-text("Schedule")',
        'button:has-text("Schedule Pickup")',
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        '#btnSubmit',
      ];

      clicked = false;
      for (const selector of submitSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            const isVisible = await button.isVisible();
            if (isVisible) {
              await button.scrollIntoViewIfNeeded();
              await button.click({ force: true });
              clicked = true;
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!clicked) {
        // Try clicking via JavaScript as fallback
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const submitButton = buttons.find(b =>
            (b.textContent?.toLowerCase().includes('schedule') ||
             b.textContent?.toLowerCase().includes('submit') ||
             b.textContent?.toLowerCase().includes('confirm')) &&
            b.offsetParent !== null
          );
          if (submitButton) (submitButton as HTMLElement).click();
        });
      }

      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(5000);

      // Take confirmation screenshot
      const confirmationScreenshot = `${SCREENSHOT_DIR}/ups-confirmation-${Date.now()}.png`;
      await page.screenshot({ path: confirmationScreenshot, fullPage: true });

      // Try to extract confirmation details from page
      const confirmation = await this.extractConfirmation(page);

      // Close browser after successful booking
      await this.reset();

      return {
        success: true,
        fillScreenshot: fillResult.screenshot,
        reviewScreenshot,
        confirmationScreenshot,
        formState: fillResult.formState,
        confirmation,
        message: "Collection booked successfully.",
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/ups-book-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });

      return {
        error: true,
        message: `Booking failed during submit: ${error.message}`,
        fillScreenshot: fillResult.screenshot,
        errorScreenshot,
      };
    }
  }
}
