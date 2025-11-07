/**
 * InstanceManager - Ensures only one instance of an app is active at a time
 * Uses BroadcastChannel for communication and localStorage only for crash detection
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
    private readonly STORAGE_KEY_PREFIX = 'instance_heartbeat_';

    constructor(appKey: string, onStateChange?: (state: InstanceState) => void) {
        this.appKey = appKey;
        this.instanceId = this.generateInstanceId();
        this.channel = new BroadcastChannel(`instance_manager_${appKey}`);
        this.stateCallback = onStateChange;

        this.setupChannel();
        this.announcePresence();
        this.requestElection();
        this.startHeartbeat();
        this.setupBeforeUnload();
    }

    private generateInstanceId(): string {
        return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private setupChannel(): void {
        this.channel.onmessage = (event) => {
            const { type, instanceId } = event.data;

            switch (type) {
                case 'announce':
                    this.handleAnnounce(instanceId);
                    break;
                case 'claim_active':
                    this.handleActiveClaim(instanceId);
                    break;
                case 'goodbye':
                    this.handleGoodbye(instanceId);
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
        // Small random delay to avoid thundering herd
        setTimeout(() => {
            // If no active instance claims status within 100ms, become active
            setTimeout(() => {
                if (!this.isActive) {
                    this.becomeActive();
                }
            }, 100);
        }, Math.random() * 50);
    }

    private handleAnnounce(instanceId: string): void {
        if (instanceId !== this.instanceId) {
            this.instances.add(instanceId);

            // If we're active, inform the new instance
            if (this.isActive) {
                this.broadcastActiveClaim();
            }

            this.notifyStateChange();
        }
    }

    private handleActiveClaim(instanceId: string): void {
        if (instanceId !== this.instanceId) {
            this.instances.add(instanceId);

            if (this.isActive) {
                // Conflict resolution: lower ID wins
                if (instanceId < this.instanceId) {
                    this.becomeDormant();
                } else {
                    // We have priority, reassert
                    this.broadcastActiveClaim();
                }
            } else {
                this.becomeDormant();
            }

            this.notifyStateChange();
        }
    }

    private handleGoodbye(instanceId: string): void {
        const wasActive = instanceId < this.instanceId || this.instances.size === 1;
        this.instances.delete(instanceId);
        this.removeHeartbeat(instanceId);

        // If the active instance left and we're dormant, become active
        if (!this.isActive && wasActive) {
            this.becomeActive();
        }

        this.notifyStateChange();
    }

    private becomeActive(): void {
        this.isActive = true;
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

    private startHeartbeat(): void {
        // Write initial heartbeat
        this.writeHeartbeat();

        this.heartbeatInterval = window.setInterval(() => {
            this.writeHeartbeat();
            this.checkForCrashedInstances();
        }, this.HEARTBEAT_INTERVAL);
    }

    private writeHeartbeat(): void {
        localStorage.setItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_${this.instanceId}`,
            Date.now().toString()
        );
    }

    private checkForCrashedInstances(): void {
        const now = Date.now();
        const crashed: string[] = [];

        this.instances.forEach(instanceId => {
            const lastHeartbeat = this.getHeartbeat(instanceId);
            if (!lastHeartbeat || now - lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
                crashed.push(instanceId);
            }
        });

        if (crashed.length > 0) {
            crashed.forEach(instanceId => {
                this.instances.delete(instanceId);
                this.removeHeartbeat(instanceId);
            });

            // If we're dormant and no other instances exist, become active
            if (!this.isActive && this.instances.size === 0) {
                this.becomeActive();
            }

            this.notifyStateChange();
        }
    }

    private getHeartbeat(instanceId: string): number | null {
        const value = localStorage.getItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_${instanceId}`
        );
        return value ? parseInt(value, 10) : null;
    }

    private removeHeartbeat(instanceId: string): void {
        localStorage.removeItem(
            `${this.STORAGE_KEY_PREFIX}${this.appKey}_${instanceId}`
        );
    }

    private setupBeforeUnload(): void {
        window.addEventListener('beforeunload', () => {
            this.channel.postMessage({
                type: 'goodbye',
                instanceId: this.instanceId
            });
            this.removeHeartbeat(this.instanceId);
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

        this.removeHeartbeat(this.instanceId);
        this.channel.close();
    }
}