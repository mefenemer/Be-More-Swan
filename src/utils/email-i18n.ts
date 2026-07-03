// src/utils/email-i18n.ts
// US-I18N-1.2 SC4: Localised subjects and greeting lines for transactional emails.
// HTML bodies remain English in Phase 1 — only subjects/greetings are localised here.
// Fallback to English if no translation exists for the requested locale.

export type SupportedLocale = 'en' | 'fr' | 'de' | 'es' | 'pt';

const EMAIL_STRINGS: Record<SupportedLocale, {
  magic_link_subject: string;
  magic_link_greeting: (name: string) => string;
  welcome_subject: (name: string) => string;
  billing_confirm_subject: string;
  cancellation_subject: string;
  deletion_subject: string;
  trial_expiry_subject: string;
}> = {
  en: {
    magic_link_subject: 'Your Be More Swan login link',
    magic_link_greeting: (name) => `Hi ${name},`,
    welcome_subject: (name) => `Welcome to Be More Swan, ${name}! 🎉`,
    billing_confirm_subject: 'Your Be More Swan subscription is confirmed',
    cancellation_subject: 'Your Be More Swan subscription has been cancelled',
    deletion_subject: 'Confirm your account deletion — Be More Swan',
    trial_expiry_subject: 'Your Be More Swan trial is ending soon',
  },
  fr: {
    magic_link_subject: 'Votre lien de connexion Be More Swan',
    magic_link_greeting: (name) => `Bonjour ${name},`,
    welcome_subject: (name) => `Bienvenue sur Be More Swan, ${name} ! 🎉`,
    billing_confirm_subject: 'Votre abonnement Be More Swan est confirmé',
    cancellation_subject: 'Votre abonnement Be More Swan a été annulé',
    deletion_subject: 'Confirmez la suppression de votre compte — Be More Swan',
    trial_expiry_subject: 'Votre essai Be More Swan se termine bientôt',
  },
  de: {
    magic_link_subject: 'Ihr Be More Swan-Anmeldelink',
    magic_link_greeting: (name) => `Hallo ${name},`,
    welcome_subject: (name) => `Willkommen bei Be More Swan, ${name}! 🎉`,
    billing_confirm_subject: 'Ihr Be More Swan-Abonnement wurde bestätigt',
    cancellation_subject: 'Ihr Be More Swan-Abonnement wurde gekündigt',
    deletion_subject: 'Bestätigen Sie die Löschung Ihres Kontos — Be More Swan',
    trial_expiry_subject: 'Ihre Be More Swan-Testphase endet bald',
  },
  es: {
    magic_link_subject: 'Tu enlace de acceso a Be More Swan',
    magic_link_greeting: (name) => `Hola ${name},`,
    welcome_subject: (name) => `¡Bienvenido a Be More Swan, ${name}! 🎉`,
    billing_confirm_subject: 'Tu suscripción a Be More Swan está confirmada',
    cancellation_subject: 'Tu suscripción a Be More Swan ha sido cancelada',
    deletion_subject: 'Confirma la eliminación de tu cuenta — Be More Swan',
    trial_expiry_subject: 'Tu prueba de Be More Swan está por terminar',
  },
  pt: {
    magic_link_subject: 'O seu link de acesso ao Be More Swan',
    magic_link_greeting: (name) => `Olá ${name},`,
    welcome_subject: (name) => `Bem-vindo ao Be More Swan, ${name}! 🎉`,
    billing_confirm_subject: 'A sua subscrição Be More Swan foi confirmada',
    cancellation_subject: 'A sua subscrição Be More Swan foi cancelada',
    deletion_subject: 'Confirme a eliminação da sua conta — Be More Swan',
    trial_expiry_subject: 'O seu período de teste Be More Swan está prestes a terminar',
  },
};

export function getEmailStrings(lang: string | null | undefined) {
  const locale = (lang && lang in EMAIL_STRINGS) ? lang as SupportedLocale : 'en';
  return EMAIL_STRINGS[locale];
}
