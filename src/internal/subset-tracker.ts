export class ActiveSubsetTracker {
	private readonly subsetIds = new Map<string, Set<string>>();
	readonly activeIds = new Set<string>();

	get size(): number {
		return this.subsetIds.size;
	}

	has(id: string): boolean {
		return this.activeIds.has(id);
	}

	set(key: string, ids: Set<string>): void {
		this.subsetIds.set(key, ids);
		this.rebuildActiveIds();
	}

	delete(key: string): void {
		this.subsetIds.delete(key);
		this.rebuildActiveIds();
	}

	deleteId(id: string): void {
		for (const ids of this.subsetIds.values()) ids.delete(id);
		this.rebuildActiveIds();
	}

	clear(): void {
		this.subsetIds.clear();
		this.rebuildActiveIds();
	}

	private rebuildActiveIds(): void {
		this.activeIds.clear();
		for (const ids of this.subsetIds.values()) {
			for (const id of ids) this.activeIds.add(id);
		}
	}
}
