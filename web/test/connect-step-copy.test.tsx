// What the Connect Cloudflare screen says about what happens next must be true of the hosted import: zones are not "chosen" there.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectStep, scopeSentence } from '../src/pages/wizards/cloudflare/ConnectStep';
import { me, renderApp } from './render';

const oauth = { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: false, encryption_configured: true };
const token = { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true };
const open = (offer: typeof oauth, whose: 'company' | 'clients', mode: 'saas' | 'self-host' = 'saas') =>
	renderApp(<ConnectStep offer={offer} onConnected={() => {}} />, { status: { mode }, routes: { 'GET /api/me': { ...me('owner'), whose_email: whose } } });

describe('Connect Cloudflare copy is true', () => {
	it('hosted, company: every active zone is added and watched; nothing is written until Apply', async () => {
		open(oauth, 'company');
		expect(await screen.findByText(/Every active zone in the account is added and watched\. Nothing is written to DNS until you press Apply on a change you have seen\./)).toBeInTheDocument();
		expect(screen.queryByText(/zones you choose/)).toBeNull();
	});
	it('hosted, agency: only the client domain being set up is added', async () => {
		open(oauth, 'clients');
		expect(await screen.findByText(/Only the zone of the client domain you are setting up is added and watched\./)).toBeInTheDocument();
		expect(screen.queryByText(/Every active zone/)).toBeNull();
	});
	it('hosted token screen says the same, outside the permissions link', async () => {
		open(token, 'company');
		expect(await screen.findByText(/Every active zone in the account is added and watched\./)).toBeInTheDocument();
		expect(screen.queryByText(/zones you choose/)).toBeNull();
	});
	it('self-host keeps its zone step, so "the zones you choose" stays true there', async () => {
		open(oauth, 'company', 'self-host');
		expect(await screen.findByText(/only writes in the zones you choose next/)).toBeInTheDocument();
	});
	it('the sentence for both forks', () => {
		expect(scopeSentence(false)).toMatch(/^Every active zone/);
		expect(scopeSentence(true)).toMatch(/^Only the zone of the client domain/);
	});
});
