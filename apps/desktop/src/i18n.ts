import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import uk from './locales/uk.json';

const LANG_KEY = 'pathloom.lang';

function savedLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? (navigator.language.startsWith('uk') ? 'uk' : 'en');
  } catch {
    return 'en';
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, uk: { translation: uk } },
  lng: savedLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: 'en' | 'uk'): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Preference only; ignore storage failures.
  }
}

export default i18n;
