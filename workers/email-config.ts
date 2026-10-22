import type { DurableObjectState } from "@cloudflare/workers-types";
import type { EmailConfig } from "./types";

export class EmailConfigDO {

	constructor(private readonly state: DurableObjectState) {}

	private async all(): Promise<EmailConfig[]> {
		return (await this.state.storage.get<EmailConfig[]>("configs")) || [];
	}

	async list(): Promise<EmailConfig[]> { return this.all(); }

	async get(nameOrAddress: string): Promise<EmailConfig | null> {
		const needle = nameOrAddress.toLowerCase();
		return (await this.all()).find((item) => item.name === needle || item.address === needle) || null;
	}

	async put(config: EmailConfig): Promise<EmailConfig> {
		const configs = await this.all();
		const index = configs.findIndex((item) => item.name === config.name || item.address === config.address);
		if (index >= 0) configs[index] = config; else configs.push(config);
		await this.state.storage.put("configs", configs);
		return config;
	}

	async delete(name: string): Promise<boolean> {
		const configs = await this.all();
		const next = configs.filter((item) => item.name !== name.toLowerCase());
		if (next.length === configs.length) return false;
		await this.state.storage.put("configs", next);
		return true;
	}
}
