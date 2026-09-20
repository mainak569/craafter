"use client";

import { Suspense, useState } from "react";
import type { Fragment } from "@/generated/prisma";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeIcon, CrownIcon, EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

import Link from "next/link";
import { ErrorBoundary } from "react-error-boundary";
import { MessagesContainer } from "../components/messages-container";
import { ProjectHeader } from "../components/project-header";
import { FragmentWeb } from "../components/fragment-web";
import { FileExplorer } from "@/components/file-explorer";
import { UserControl } from "@/components/user-control";
import { useAuth } from "@clerk/nextjs";
import { useMediaQuery } from "@/hooks/use-media-query";

interface Props {
  projectId: string;
};

export const ProjectView = ({ projectId }: Props) => {
  const { has } = useAuth();
  const hasProAccess = has?.({ plan: "pro" });

  const [activeFragment, setActiveFragment] = useState<Fragment | null>(null);
  const [tabState, setTabState] = useState<"preview" | "code">("preview");
  // Side by side is unusable on a phone (the chat would be ~100px wide), so the
  // panels stack there, with the handle to give either one more room
  // Side by side needs room for both: below 1024px the chat (or file tree)
  // would be too narrow to read, so the panels stack instead
  const isNarrow = useMediaQuery("(max-width: 1023px)");

  return (
    <div className="h-screen">
        <ResizablePanelGroup
            key={isNarrow ? "stacked" : "side-by-side"}
            direction={isNarrow ? "vertical" : "horizontal"}
        >
            <ResizablePanel
                defaultSize={isNarrow ? 45 : 35}
                minSize={isNarrow ? 25 : 20}
                className="flex flex-col min-h-0"
            >
                <ErrorBoundary fallback={<p>Project header error</p>}>
                    <Suspense fallback={<p>Loading project...</p>}>
                        <ProjectHeader projectId={projectId} />
                    </Suspense>
                </ErrorBoundary>
                <ErrorBoundary fallback={<p>Messages container error</p>}>
                    <Suspense fallback={<p>Loading messages...</p>}>
                        <MessagesContainer 
                            projectId={projectId} 
                            activeFragment={activeFragment}
                            setActiveFragment={setActiveFragment}
                        /> 
                        {/* Container to render messages in a project */}
                    </Suspense>
                </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle className="hover:bg-primary transition-colors" />
            <ResizablePanel
                defaultSize={isNarrow ? 55 : 65}
                minSize={isNarrow ? 30 : 50}
                className="flex flex-col min-h-0"
            >
                <Tabs
                    className="h-full gap-y-0"
                    defaultValue="preview"
                    value={tabState}
                    onValueChange={(value) => setTabState(value as "preview" | "code")}
                >
                    <div className="w-full flex items-center p-2 border-b gap-x-2 shrink-0">
                        <TabsList className="h-8 p-0 border rounded-md">
                            <TabsTrigger value="preview" className="rounded-md">
                                <EyeIcon /> <span>Demo</span>
                            </TabsTrigger>
                            <TabsTrigger value="code" className="rounded-md">
                                <CodeIcon /> <span>Code</span>
                            </TabsTrigger>
                        </TabsList>
                        <div className="ml-auto flex items-center gap-x-2">
                            {!hasProAccess && (
                                <Button asChild variant="tertiary" size="sm">
                                    <Link href="/pricing">
                                        <CrownIcon /> Upgrade
                                    </Link>
                                </Button>
                            )}
                            <UserControl />
                        </div>
                    </div>
                    <TabsContent value="preview" className="flex-1 min-h-0">
                        {!!activeFragment && (
                            <FragmentWeb
                                key={activeFragment.id}
                                data={activeFragment}
                                projectId={projectId}
                            />
                        )}
                    </TabsContent>
                    <TabsContent value="code" className="flex-1 min-h-0">
                        {!!activeFragment && (
                            <FileExplorer
                                files={activeFragment.files as {[path: string]: string}}
                            />
                        )}
                    </TabsContent>
                </Tabs>
            </ResizablePanel>
        </ResizablePanelGroup>
    </div>

  );
};
