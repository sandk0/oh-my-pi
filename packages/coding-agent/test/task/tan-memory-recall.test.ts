/**
 * `/tan` inherits the parent's conversation for context, not as new memory.
 * The clone sends the parent's recalled prompt unchanged and retains only
 * the work added to its own transcript.
 */
import { afterEach, expect, it, vi } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = getBundledModel("muse-code", "muse-spark-1.3-contributor");
const MEMORY = "The deploy host is alpha-7.";

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

async function createParent(
	dir: TempDir,
	authStorage: AuthStorage,
	settings: Settings,
	activeModel = model,
	sessionManager = SessionManager.create(dir.path(), dir.join("parent")),
): Promise<AgentSession> {
	const { session } = await sdk.createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage,
		model: activeModel,
		settings,
		sessionManager,
		toolNames: [],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	return session;
}

async function runTan(parent: AgentSession, work: string, onClone?: () => Promise<void>) {
	if (onClone) {
		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			await onClone();
			return created;
		});
	}
	const manager = parent.asyncJobManager;
	if (!manager) throw new Error("Missing async job manager");
	let runJob: (() => Promise<unknown>) | undefined;
	vi.spyOn(manager, "register").mockImplementation((_type, _label, run) => {
		runJob = () =>
			run({
				jobId: "tan-test",
				signal: new AbortController().signal,
				reportProgress: async () => {},
				markRunning: () => {},
			});
		return "tan-test";
	});
	const context = {
		session: parent,
		sessionManager: parent.sessionManager,
		showHookConfirm: async () => true,
		rebuildChatFromMessages: () => {},
		settings: parent.settings,
		showError: (message: string) => {
			throw new Error(message);
		},
		showWarning: () => {},
		showStatus: () => {},
	} as unknown as InteractiveModeContext;
	await new TanCommandController(context).start(work);
	if (!runJob) throw new Error("Tan did not register its job");
	await runJob();
}

it.each(["unchanged", "forgotten"])("sends the inherited recall from a /tan clone (%s memory)", async change => {
	using dir = TempDir.createSync("@omp-tan-memory-recall-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	auth.keys.setRuntime("antigravity-cli", "test-key");
	auth.keys.setRuntime("google", "test-key");
	const requests: Context[] = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "alpha-7" }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(streamModel, context, options) => {
				requests.push(context);
				return mock.stream(streamModel, context, options);
			},
			slow,
		),
	);
	// Wait for each background memory start before driving the corresponding session.
	const mnemopiStarts = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
	const realStart = mnemopiBackend.start;
	const pendingStarts = [...mnemopiStarts];
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await realStart.call(mnemopiBackend, options);
		pendingStarts.shift()?.resolve();
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.autoRetain": false,
		"mnemopi.recallRelevance": "off",
	});
	try {
		let parent = await createParent(dir, auth, settings);
		try {
			await mnemopiStarts[0]!.promise;
			const state = getMnemopiSessionState(parent)!;
			const id = state.rememberScoped(MEMORY);
			await parent.prompt("Where is the deploy host?");
			const work = "Check the deploy host";
			if (change === "forgotten") {
				expect(state.editScopedMemory("forget", id).status).toBe("deleted");
				const sessionFile = parent.sessionManager.getSessionFile()!;
				await parent.dispose();
				parent = await createParent(
					dir,
					auth,
					settings,
					getBundledModel("antigravity-cli", "gemini-4-hydrogen"),
					await SessionManager.open(sessionFile, dir.join("parent")),
				);
				await mnemopiStarts[1]!.promise;
				await parent.prompt("And which host serves staging?");
				expect(requests.at(-1)?.systemPrompt?.join("\n")).not.toContain(MEMORY);
				await parent.setModel(getBundledModel("google", "gemini-3-pro-preview"));
			} else {
				await parent.prompt("And which host serves staging?");
			}
			const parentPrompt = parent.systemPrompt;
			expect(parentPrompt.join("\n").split(MEMORY)).toHaveLength(2);

			const cloneRequestIndex = requests.length;
			await runTan(parent, work);
			const cloneRequest = requests
				.slice(cloneRequestIndex)
				.find(request =>
					request.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes(work),
					),
				);
			expect(cloneRequest?.systemPrompt).toEqual(parentPrompt);
			if (change === "forgotten") {
				const expected = `No longer in memory (deleted, invalidated, or expired): ${MEMORY}`;
				const cloneMessages = cloneRequest?.messages.filter(message => message.role === "developer");
				expect(JSON.stringify(cloneMessages)).toContain(expected);
				await parent.prompt("Recheck the deploy host");
				const parentMessages = requests.at(-1)?.messages.filter(message => message.role === "developer");
				expect(JSON.stringify(parentMessages)).toContain(expected);
			}
		} finally {
			await parent.dispose();
		}
	} finally {
		auth.close();
	}
});

it("retains only new /tan turns in a separate Hindsight document", async () => {
	using dir = TempDir.createSync("@omp-tan-hindsight-retain-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	const apiUrl = "http://hindsight.test";
	const documents = new Map<string, string>();
	const parentRetained = Promise.withResolvers<void>();
	const forkRetained = Promise.withResolvers<void>();
	const captureRetain = async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
		const url = String(input);
		if (!url.startsWith(`${apiUrl}/`)) throw new Error(`Unexpected request: ${url}`);
		if (url.endsWith("/memories") && init?.method === "POST") {
			const { items }: { items: { document_id: string; content: string }[] } = JSON.parse(String(init.body));
			for (const item of items) {
				documents.set(item.document_id, item.content);
				(item.document_id.includes(":tan:") ? forkRetained : parentRetained).resolve();
			}
		}
		return Response.json({});
	};
	const fetchMock = Object.assign(captureRetain, { preconnect: globalThis.fetch.preconnect });
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	let reply = "The parent deploy host is alpha-7.";
	const mock = createMockModel({ handler: () => ({ content: [{ type: "text", text: reply }] }) });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(settings, mock.stream, slow),
	);
	const parentStarted = Promise.withResolvers<void>();
	const cloneStarted = Promise.withResolvers<void>();
	const realStart = hindsightBackend.start;
	vi.spyOn(hindsightBackend, "start").mockImplementation(async options => {
		await realStart.call(hindsightBackend, options);
		(options.session.sessionId.includes(":tan:") ? cloneStarted : parentStarted).resolve();
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"memory.backend": "hindsight",
		"hindsight.apiUrl": apiUrl,
		"hindsight.autoRecall": false,
		"hindsight.mentalModelsEnabled": false,
		"hindsight.retainEveryNTurns": 1,
	});
	try {
		const parent = await createParent(dir, auth, settings);
		try {
			await parentStarted.promise;
			await parent.prompt("Parent transcript: the deploy host is alpha-7.");
			await parentRetained.promise;
			const parentDocument = documents.get(parent.sessionId);
			expect(parentDocument).toContain("the deploy host is alpha-7");
			expect(parentDocument).toContain("The parent deploy host is alpha-7.");
			reply = "Staging deploys from beta-2.";

			await runTan(parent, "Tan transcript: inspect staging.", () => cloneStarted.promise);
			await forkRetained.promise;
			const forkDocument = [...documents].find(([id]) => id.startsWith(`${parent.sessionId}:tan:`))?.[1];
			expect(forkDocument).toContain("inspect staging");
			expect(forkDocument).toContain("Staging deploys from beta-2.");
			expect(forkDocument).not.toContain("the deploy host is alpha-7");
			expect(forkDocument).not.toContain("The parent deploy host is alpha-7.");
			expect(documents.get(parent.sessionId)).toBe(parentDocument);
		} finally {
			await parent.dispose();
		}
	} finally {
		auth.close();
	}
});
