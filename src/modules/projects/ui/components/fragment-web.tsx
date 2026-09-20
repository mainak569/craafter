import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCcwIcon, TriangleAlertIcon, WrenchIcon, XIcon } from "lucide-react";
import type { Fragment } from "@/generated/prisma";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";

interface Props {
  data: Fragment;
  projectId: string;
}

// Sent by the error reporter the code agent puts in every sandbox
// (ERROR_REPORTER_SOURCE in src/inngest/utils.ts)
interface RuntimeError {
  message: string;
  stack?: string;
  path: string;
}

export function FragmentWeb({ data, projectId }: Props) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [fragmentKey, setFragmentKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<RuntimeError | null>(null);

  useEffect(() => {
    let sandboxOrigin: string;
    try {
      sandboxOrigin = new URL(data.sandboxUrl).origin;
    } catch {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== sandboxOrigin || event.data?.type !== "craafter:runtime-error") return;
      // Keep the first error: later ones are often caused by it
      setRuntimeError((current) => current ?? {
        message: String(event.data.message),
        stack: typeof event.data.stack === "string" ? event.data.stack : undefined,
        path: typeof event.data.path === "string" ? event.data.path : "/",
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [data.sandboxUrl]);

  const fixError = useMutation(trpc.messages.create.mutationOptions({
    onSuccess: () => {
      setRuntimeError(null);
      queryClient.invalidateQueries(trpc.messages.getMany.queryOptions({ projectId }));
      queryClient.invalidateQueries(trpc.usage.status.queryOptions());
    },
    onError: (error) => {
      toast.error(error.message);
      if (error.data?.code === "TOO_MANY_REQUESTS") {
        router.push("/pricing");
      }
    },
  }));

  const onFix = () => {
    if (!runtimeError) return;
    const { message, stack, path } = runtimeError;
    const where = path === "/" ? "" : ` on ${path}`;
    const value = `The preview throws this error${where}. Please fix it:\n\n${message}${
      stack ? `\n\n${stack.split("\n").slice(0, 12).join("\n")}` : ""
    }`;
    fixError.mutate({ projectId, value: value.slice(0, 10000) });
  };

  const onRefresh = () => {
    setRuntimeError(null);
    setFragmentKey((prev) => prev + 1);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(data.sandboxUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="p-2 border-b bg-sidebar flex items-center gap-x-2">
        <Hint text="Refresh sandbox" side="bottom" align="start">
          <Button size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCcwIcon />
          </Button>
        </Hint>
        <Hint text="Copy sandbox URL" side="bottom">
            <Button
                size="sm"
                variant="outline"
                onClick={handleCopy}
                disabled={!data.sandboxUrl || copied}
                className="flex-1 justify-start text-start font-normal"
            >
                <span className="truncate">
                {data.sandboxUrl}
                </span>
            </Button>
        </Hint>
        <Hint text="Open in new tab" side="bottom" align="end">
            <Button
                size="sm"
                disabled={!data.sandboxUrl}
                variant="outline"
                onClick={() => {
                    if(!data.sandboxUrl) return;
                    window.open(data.sandboxUrl, "_blank");
                }}
            >
                <ExternalLinkIcon />
            </Button>
        </Hint>
      </div>
      {runtimeError && (
        <div className="p-2 border-b bg-destructive/10 flex items-center gap-x-2 text-sm">
          <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
          <span className="flex-1 min-w-0 truncate" title={runtimeError.message}>
            The preview hit an error: {runtimeError.message}
          </span>
          <Button size="sm" onClick={onFix} disabled={fixError.isPending}>
            <WrenchIcon /> Fix it
          </Button>
          <Hint text="Dismiss" side="bottom" align="end">
            <Button size="sm" variant="ghost" onClick={() => setRuntimeError(null)}>
              <XIcon />
            </Button>
          </Hint>
        </div>
      )}
      <iframe
        key={fragmentKey}
        className="h-full w-full"
        sandbox="allow-forms allow-scripts allow-same-origin"
        // Generated apps often have "Copy" buttons, which fail in an iframe without this
        allow="clipboard-read; clipboard-write"
        loading="lazy"
        src={data.sandboxUrl}
      />
    </div>
  );
}
