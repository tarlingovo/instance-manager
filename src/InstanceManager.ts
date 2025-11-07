/**
 * InstanceManager - Ensures only one instance of an app is active at a time
 * Uses BroadcastChannel for communication and localStorage for state persistence
 */

export interface InstanceState {
    isActive: boolean;
    instanceCount: number;
}

export class InstanceManager {
    private appKey: string;
    private instanceId: string;
    private channel: BroadcastChannel;
    private isActive: boolean = false;
    private instances: Set<string> = new Set();
    private heartbeatInterval?: number;
    private stateCallback?: (state: InstanceState) => void;

    private readonly HEARTBEAT_INTERVAL = 2000; // 2 seconds
    private readonly HEARTBEAT_TIMEOUT = 5000; // 5 seconds
    private readonly STORAGE_KEY_PREFIX = 'instance_manager_';

    constructor(appKey: string, onStateChange?: (state: InstanceState) => void) {
        this.appKey = appKey;
        this.instanceId = this.generateInstanceId();
        this.channel = new BroadcastChannel(`${this.STORAGE_KEY_PREFIX}${appKey}`);
        this.stateCallback = onStateChange;

        this.setupChannel();
        this.announcePresence();
        this.requestElection();
        this.startHeartbeat();
        this.setupBeforeUnload();
        this.cleanupStaleInstances();
    }

    private generateInstanceId(): string {
        return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private setupChannel(): void {
        this.channel.onmessage = (event) => {
            const { type, instanceId, instances } = event.data;

            switch (type) {
                case 'announce':
                    this.handleAnnounce(instanceId);
                    break;
                case 'request_election':
                    this.handleElectionRequest(instanceId);
                    break;
                case 'claim_active':
                    this.handleActiveClaim(instanceId);
                    break;
                case 'heartbeat':
                    this.handleHeartbeat(instanceId);
                    break;
                case 'goodbye':
                    this.handleGoodbye(instanceId);
                    break;
                case 'instance_list':
                    this.handleInstanceList(instances);
                    break;
            }
        };
    }

    private announcePresence(): void {
        this.channel.postMessage({
            type: 'announce',
            instanceId: this.instanceId
        });
    }

    private requestElection(): void {
        // Use a small random delay to avoid thundering herd
        setTimeout(() => {
            this.channel.postMessage({
                type: 'request_election',
                instanceId: this.instanceId
            });

            // If no one claims active status within 100ms, claim it
            setTimeout(() => {
                if (!this.isActive && !this.hasActiveInstance()) {
                    this.becomeActive();
                }
            }, 100);
        }, Math.random() * 50);
    }

    private handleAnnounce(instanceId: string): void {
        if (instanceId !== this.instanceId) {
            this.instances.add(instanceId);
            this.updateLastSeen(instanceId);

            // If we're active, inform the new instance
            if (this.isActive) {
                this.broadcastActiveClaim();
            }

            // Share our instance list
            this.broadcastInstanceList();
            this.notifyStateChange();
        }
    }

    private handleElectionRequest(instanceId: string): void {
        if (instanceId !== this.instanceId) {
            this.instances.add(instanceId);
            this.updateLastSeen(instanceId);
        }

        // If we're active, reassert our status
        if (this.isActive) {
            this.broadcastActiveClaim();
        }
    }

    private handleActiveClaim(instanceId: string): void {
        if (instanceId !== this.instanceId && this.isActive) {
            // Another instance is claiming active status
            // Use instance ID as tiebreaker (lower ID wins)
            if (instanceId < this.instanceId) {
                this.becomeDormant();
            } else {
                // We have priority, reassert
                this.broadcastActiveClaim();
            }
        } else if (instanceId !== this.instanceId) {
            this.becomeDormant();
        }

        this.instances.add(instanceId);
        this.updateLastSeen(instanceId);
        this.notifyStateChange();
    }

    private handleHeartbeat(instanceId: string): void {
        if (instanceId !== this.instanceId) {
            this.instances.add(instanceId);
            this.updateLastSeen(instanceId);
            this.notifyStateChange();
        }
    }

    private handleGoodbye(instanceId: string): void {
        this.instances.delete(instanceId);
        this.removeLastSeen(instanceId);

        // If the active instance left and we're dormant, try to become active
        if (!this.isActive && !this.hasActiveInstance()) {
            this.becomeActive();
        }

        this.notifyStateChange();
    }

    private handleInstanceList(instances: string[]): void {
        instances.forEach(id => {
            if (id !== this.instanceId) {
                this.instances.add(id);
            }
        });
        this.notifyStateChange();
    }

    private becomeActive(): void {
        this.isActive = true;
        this.setActiveInstance(this.instanceId);
        this.broadcastActiveClaim();
        this.notifyStateChange();
    }

    private becomeDormant(): void {
        this.isActive = false;
        this.notifyStateChange();
    }

    private broadcastActiveClaim(): void {
        this.channel.postMessage({
            type: 'claim_active',
            instanceId: this.instanceId
        });
    }

    private broadcastInstanceList(): void {
        this.channel.postMessage({
            type: 'instance_list',
            instances: Array.from(this.instances)
        });
    }

    private startHeartbeat(): void {
        this.heartbeatInterval = window.setInterval(() => {
            this.channel.postMessage({
                type: 'heartbeat',
                instanceId: this.instanceId
            });

            this.cleanupStaleInstances();
        }, this.HEARTBEAT_INTERVAL);
    }

    private cleanupStaleInstances(): void {
        const now = Date.now();
        let changed = false;

        this.instances.forEach(instanceId => {
            const lastSeen = this.getLastSeen(instanceId);
            if (lastSeen && now - lastSeen > this.HEARTBEAT_TIMEOUT) {
                this.instances.delete(instanceId);
                this.removeLastSeen(instanceId);
                changed = true;
            }
        });

        // Check if active instance is stale
        const activeInstanceId = this.getActiveInstance();
        if (activeInstanceId && activeInstanceId !== this.instanceId) {
            const lastSeen = this.getLastSeen(activeInstanceId);
            if (lastSeen && now - lastSeen > this.HEARTBEAT_TIMEOUT) {
                this.clearActiveInstance();
                if (!this.isActive) {
                    this.becomeActive();
                }
                changed = true;
            }
        }

        if (changed) {
            this.notifyStateChange();
        }
    }

    private setupBeforeUnload(): void {
        window.addEventListener('beforeunload', () => {
            this.channel.postMessage({
                type: 'goodbye',
                instanceId: this.instanceId
            });

            if (this.isActive) {
                this.clearActiveInstance();
            }

            this.removeLastSeen(this.instanceId);
        });
    }

    private notifyStateChange(): void {
        if (this.stateCallback) {
            this.stateCallback({
                isActive: this.isActive,
                instanceCount: this.instances.size
            });
        }
    }

    // LocalStorage helpers for persistence
    private setActiveInstance(instanceId: string): void {
        localStorage.setItem(`${this.STORAGE_KEY_PREFIX}${this.appKey}_active`, instanceId);
    }

    private getActiveInstance(): string | null {
        return localStorage.getItem(`${this.STORAGE_KEY_PREFIX}${this.appKey}_active`);
    }

    private hasActiveInstance(): boolean {
        return this.getActiveInstance() !== null;
    }

    private clearActiveInstance(): void {
        localStorage.removeItem(`${this.STORAGE_KEY_PREFIX}${this.appKey}_active`);
    }

    private updateLastSeen(instanceId: string): void {
        localStorage.setItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_lastseen_${instanceId}`,
            Date.now().toString()
        );
    }

    private getLastSeen(instanceId: string): number | null {
        const value = localStorage.getItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_lastseen_${instanceId}`
        );
        return value ? parseInt(value, 10) : null;
    }

    private removeLastSeen(instanceId: string): void {
        localStorage.removeItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_lastseen_${instanceId}`
        );
    }

    public getState(): InstanceState {
        return {
            isActive: this.isActive,
            instanceCount: this.instances.size
        };
    }

    public destroy(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.channel.postMessage({
            type: 'goodbye',
            instanceId: this.instanceId
        });

        if (this.isActive) {
            this.clearActiveInstance();
        }

        this.removeLastSeen(this.instanceId);
        this.channel.close();
    }
}