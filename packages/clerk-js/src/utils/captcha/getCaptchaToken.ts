import type { CaptchaProvider, CaptchaWidgetType } from '@clerk/types';

import { getHCaptchaToken } from './hcaptcha';
import { getTunstileToken } from './turnstile';

type CaptchaOptions = {
  siteKey: string;
  scriptUrl: string;
  widgetType: CaptchaWidgetType;
  invisibleSiteKey: string;
  captchaProvider: CaptchaProvider;
};

/*
 * This is a temporary solution to test different captcha providers, until we decide on a single one.
 */
export const getCaptchaToken = (captchaOptions: CaptchaOptions) => {
  if (__BUILD_ENABLE_RHC__) {
    const { captchaProvider, ...captchaProviderOptions } = captchaOptions;
    if (captchaProvider === 'hcaptcha') {
      return getHCaptchaToken(captchaProviderOptions);
    }

    return getTunstileToken(captchaProviderOptions);
  }

  return Promise.reject();
};
