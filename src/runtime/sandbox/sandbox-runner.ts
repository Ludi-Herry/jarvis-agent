export type SandboxBackend = 'unavailable' | 'wsl2-unshare' | 'windows-appcontainer' | 'docker';

export type SandboxNetworkMode = 'none' | 'explicit';

export type SandboxFailureMode = 'unavailable' | 'failed-to-start' | 'timed-out';

export interface SandboxMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly access: 'read-only' | 'read-write';
}

export interface SandboxLimits {
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly maxProcesses?: number;
  readonly memoryBytes?: number;
  readonly cpuMillis?: number;
}

export interface SandboxRunRequest {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly mounts: readonly SandboxMount[];
  readonly networkMode: SandboxNetworkMode;
  readonly limits: SandboxLimits;
  readonly reason: string;
}

export interface SandboxAudit {
  readonly backend: SandboxBackend;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly mounts: readonly SandboxMount[];
  readonly networkMode: SandboxNetworkMode;
  readonly limits: SandboxLimits;
}

export type SandboxRunResult =
  | {
      readonly status: 'completed';
      readonly backend: SandboxBackend;
      readonly audit: SandboxAudit;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly status: SandboxFailureMode;
      readonly backend: SandboxBackend;
      readonly audit: SandboxAudit;
      readonly reason: string;
    };

export interface SandboxRunner {
  readonly backend: SandboxBackend;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export function createUnavailableSandboxRunner(reason = 'No sandbox backend is configured.'): SandboxRunner {
  return {
    backend: 'unavailable',
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      return sandboxUnavailable(request, reason);
    },
  };
}

export function sandboxUnavailable(request: SandboxRunRequest, reason: string): SandboxRunResult {
  return {
    status: 'unavailable',
    backend: 'unavailable',
    audit: auditSandboxRequest('unavailable', request),
    reason,
  };
}

export function auditSandboxRequest(backend: SandboxBackend, request: SandboxRunRequest): SandboxAudit {
  return {
    backend,
    command: [...request.command],
    cwd: request.cwd,
    mounts: request.mounts.map((mount) => ({ ...mount })),
    networkMode: request.networkMode,
    limits: { ...request.limits },
  };
}
