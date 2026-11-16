// The assistants a person may connect, and how: ONE list, read by the Agents page. `needs` is what the assistant relies on to introduce itself to
// this instance: `cimd` a published client ID metadata document, `dcr` registering itself (the instance owner turns that on), `either` both work and it
// uses the first it finds. The page asks the server what this instance supports (GET /api/agents/status) and shows each entry as working or not.
// The steps follow each assistant's own documentation (ADR 0015); the wording is checked against the real assistants in a follow-up.
export type RegistrationNeed = 'dcr' | 'cimd' | 'either';

export interface AgentClient {
	client: string;
	needs: RegistrationNeed;
	/** Plain steps. `{url}` stands for the server URL. */
	steps: string[];
}

export const AGENT_CLIENTS: readonly AgentClient[] = [
	{
		client: 'Claude',
		needs: 'either',
		steps: [
			'In Claude (the website or the desktop app), open Settings, then Connectors.',
			'Choose Add custom connector, give it a name such as Ready Set Mail, and paste {url} as its address.',
			'Choose Connect. Claude opens a Ready Set Mail page: sign in if asked, choose what it may do, then Allow access.',
		],
	},
	{
		client: 'ChatGPT',
		needs: 'either',
		steps: [
			'In ChatGPT, open Settings and look for Apps (or Connectors). Adding your own may need developer mode switched on.',
			'Add a new app, give it a name such as Ready Set Mail, and paste {url} as its server address.',
			'Choose Connect. ChatGPT opens a Ready Set Mail page: sign in if asked, choose what it may do, then Allow access.',
		],
	},
	{
		client: 'Cursor',
		needs: 'dcr',
		steps: [
			"In Cursor, open Settings, then the MCP section, and add a server.",
			'Give it the name Ready Set Mail and the address {url}, as a remote (HTTP) server.',
			'Choose Connect. Cursor opens a Ready Set Mail page: sign in if asked, choose what it may do, then Allow access.',
		],
	},
	{
		client: 'VS Code',
		needs: 'either',
		steps: [
			'In VS Code, open the Command Palette and run MCP: Add Server.',
			'Choose HTTP, paste {url}, and give it the name Ready Set Mail.',
			'When VS Code asks to sign in, a Ready Set Mail page opens: sign in if asked, choose what it may do, then Allow access.',
		],
	},
];

export interface AgentCapabilities {
	dynamic_registration: boolean;
	metadata_documents: boolean;
}

/** Can this assistant connect to an instance that supports these? */
export function canConnect(client: AgentClient, caps: AgentCapabilities): boolean {
	if (client.needs === 'dcr') return caps.dynamic_registration;
	if (client.needs === 'cimd') return caps.metadata_documents;
	return caps.dynamic_registration || caps.metadata_documents;
}
