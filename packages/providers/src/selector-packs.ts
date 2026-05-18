export interface SelectorDefinition {
  primary: string;
  fallbacks: string[];
  required: boolean;
}

export interface SelectorPack {
  provider: string;
  version: string;
  selectors: Record<string, SelectorDefinition>;
}

export interface PageFingerprint {
  id: string;
  provider: string;
  version: string;
  urlPattern: string;
  titlePattern: string;
  requiredDomAnchors: string[];
  requiredTextAnchors: string[];
  captchaIndicators: string[];
}

export const selectorPacks: Record<string, SelectorPack> = {
  hh: {
    provider: "hh",
    version: "2026-05-16-v1",
    selectors: {
      job_card: {
        primary: "[data-qa='vacancy-serp__vacancy-title']",
        fallbacks: ["a[href*='/vacancy/']", "xpath=//a[contains(@href, '/vacancy/')]"],
        required: true
      },
      apply_button: {
        primary: "[data-qa='vacancy-response-link-top']",
        fallbacks: ["button:has-text('Откликнуться')", "a:has-text('Откликнуться')"],
        required: true
      },
      cover_letter_textarea: {
        primary: "textarea[name='letter']",
        fallbacks: ["[data-qa='vacancy-response-popup-form-letter-input']", "textarea"],
        required: false
      }
    }
  },
  robota: {
    provider: "robota",
    version: "2026-05-16-v1",
    selectors: {
      job_card: {
        primary: "[data-test='job-title']",
        fallbacks: ["a[href*='/jobs/']", "xpath=//a[contains(@href, '/jobs/')]"],
        required: true
      },
      apply_button: {
        primary: "[data-test='apply-button']",
        fallbacks: ["button:has-text('Apply')", "button:has-text('Відгукнутися')"],
        required: true
      },
      cover_letter_textarea: {
        primary: "textarea[name='coverLetter']",
        fallbacks: ["textarea", "[data-test='cover-letter']"],
        required: false
      }
    }
  },
  telegram: {
    provider: "telegram",
    version: "2026-05-16-v1",
    selectors: {}
  }
};

export const pageFingerprints: Record<string, PageFingerprint[]> = {
  hh: [
    {
      id: "hh_job_page",
      provider: "hh",
      version: "2026-05-16-v1",
      urlPattern: "/vacancy/",
      titlePattern: "Node|Backend|ваканс",
      requiredDomAnchors: ["[data-qa='vacancy-response-link-top']"],
      requiredTextAnchors: ["Откликнуться"],
      captchaIndicators: ["captcha", "are you human", "проверка"]
    },
    {
      id: "hh_results_page",
      provider: "hh",
      version: "2026-05-16-v1",
      urlPattern: "/search/vacancy",
      titlePattern: "vacancy|ваканс",
      requiredDomAnchors: ["[data-qa='vacancy-serp__vacancy-title']"],
      requiredTextAnchors: ["Найден", "ваканс"],
      captchaIndicators: ["captcha", "are you human", "проверка"]
    },
    {
      id: "hh_apply_form",
      provider: "hh",
      version: "2026-05-16-v1",
      urlPattern: "/vacancy/",
      titlePattern: "Отклик|Apply",
      requiredDomAnchors: ["[data-qa='vacancy-response-popup']"],
      requiredTextAnchors: ["Откликнуться"],
      captchaIndicators: ["captcha", "are you human", "проверка"]
    },
    {
      id: "hh_confirmation",
      provider: "hh",
      version: "2026-05-16-v1",
      urlPattern: "/applicant/resumes",
      titlePattern: "confirmation|отклик",
      requiredDomAnchors: ["[data-qa='vacancy-response-success']"],
      requiredTextAnchors: ["Отклик отправлен"],
      captchaIndicators: ["captcha", "are you human", "проверка"]
    }
  ],
  robota: [
    {
      id: "robota_search_results",
      provider: "robota",
      version: "2026-05-18-v1",
      urlPattern: "/jobs",
      titlePattern: "jobs|ваканс",
      requiredDomAnchors: ["[data-test='job-title']"],
      requiredTextAnchors: ["jobs", "ваканс"],
      captchaIndicators: ["captcha", "cloudflare"]
    },
    {
      id: "robota_job_page",
      provider: "robota",
      version: "2026-05-16-v1",
      urlPattern: "/jobs/",
      titlePattern: "job|вакансія",
      requiredDomAnchors: ["[data-test='apply-button']"],
      requiredTextAnchors: ["Apply", "Відгукнутися"],
      captchaIndicators: ["captcha", "cloudflare"]
    },
    {
      id: "robota_apply_form",
      provider: "robota",
      version: "2026-05-18-v1",
      urlPattern: "/jobs/",
      titlePattern: "apply|відгук",
      requiredDomAnchors: ["[data-test='apply-form']"],
      requiredTextAnchors: ["Apply"],
      captchaIndicators: ["captcha", "cloudflare"]
    },
    {
      id: "robota_confirmation",
      provider: "robota",
      version: "2026-05-18-v1",
      urlPattern: "/profile/applications",
      titlePattern: "application|відгук",
      requiredDomAnchors: ["[data-test='application-success']"],
      requiredTextAnchors: ["Application sent"],
      captchaIndicators: ["captcha", "cloudflare"]
    }
  ],
  telegram: []
};
