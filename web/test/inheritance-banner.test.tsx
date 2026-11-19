import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InheritanceBanner } from '../src/components/domain/InheritanceBanner';

describe('InheritanceBanner (D)', () => {
	it('says SPF is checked at the return-path domain, and a subdomain needs its own record only if it is that name', () => {
		render(<InheritanceBanner pc={{ domain: 'example.com', has_dmarc: true } as never} subdomain="app.example.com" />);
		const t = screen.getByText(/SPF is checked at each message's return-path/).textContent!;
		expect(t).toContain('needs its own SPF record only if mail is sent with app.example.com itself as the return-path');
		expect(t).not.toBe('app.example.com needs its own SPF record.');
	});
});
