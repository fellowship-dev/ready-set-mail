// The shared frame and field live in the design system. Every auth screen gets the hosted service's quiet footer (Terms,
// Privacy, Talk to Max); a self-hosted instance shows only the links its operator configured, or nothing.
import { AuthLayout as Frame, type AuthLayoutProps } from '@ready-set-mail/ui';
import { LegalLinks } from './LegalLinks';

export { Field } from '@ready-set-mail/ui';

export function AuthLayout(props: Omit<AuthLayoutProps, 'footer'>) {
	return <Frame {...props} footer={<LegalLinks />} />;
}
