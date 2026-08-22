import { describe, expect, it } from "bun:test";
import { parseStandaloneStatsArgs } from "../src/index";
import { formatStatsDashboardUrl } from "../src/server";

describe("standalone stats CLI", () => {
	it("keeps the production parser loopback-only by default", () => {
		expect(parseStandaloneStatsArgs([])).toEqual({
			port: 3847,
			host: "127.0.0.1",
			json: false,
			sync: false,
			help: false,
		});
	});

	it("forwards explicit bind hosts and formats IPv6 dashboard URLs", () => {
		expect(parseStandaloneStatsArgs(["--host", "::", "--port", "3850"])).toMatchObject({
			port: 3850,
			host: "::",
		});
		expect(formatStatsDashboardUrl("::", 3850)).toBe("http://[::]:3850");
		expect(formatStatsDashboardUrl("2001:db8::1", 3850)).toBe("http://[2001:db8::1]:3850");
	});

	it("rejects malformed and out-of-range ports", () => {
		expect(() => parseStandaloneStatsArgs(["--port", "3847x"])).toThrow("Invalid port: 3847x");
		expect(() => parseStandaloneStatsArgs(["--port", "0x5000"])).toThrow("Invalid port: 0x5000");
		expect(() => parseStandaloneStatsArgs(["--port", "65536"])).toThrow("Invalid port: 65536");
		expect(parseStandaloneStatsArgs(["--port", "0"]).port).toBe(0);
		expect(parseStandaloneStatsArgs(["--port", "65535"]).port).toBe(65535);
	});
});
