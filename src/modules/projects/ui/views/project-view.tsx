"use client";

import { Suspense, useState } from "react";
import { Fragment } from "@/generated/prisma/wasm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeIcon, Crown, CrownIcon, EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeView } from "@/components/code-view";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

import Link from "next/link";
import { MessagesContainer } from "../components/messages-container";
import { ProjectHeader } from "../components/project-header";
import { FragmentWeb } from "../components/fragment-web";
import { FileExplorer } from "@/components/file-explorer";
import path from "path";

interface Props {
  projectId: string;
};

export const ProjectView = ({ projectId }: Props) => {
  const [activeFragment, setActiveFragment] = useState<Fragment | null>(null);
  const [tabState, setTabState] = useState<"preview" | "code">("preview");
  return (
    <div className="h-screen">
        <ResizablePanelGroup direction="horizontal">
            <ResizablePanel
                defaultSize={35}
                minSize={20}
                className="flex flex-col min-h-0"
            >
                <Suspense fallback={<p>Loading project...</p>}>
                    <ProjectHeader projectId={projectId} />
                </Suspense>
                <Suspense fallback={<p>Loading messages...</p>}>
                    <MessagesContainer 
                        projectId={projectId} 
                        activeFragment={activeFragment}
                        setActiveFragment={setActiveFragment}
                    /> 
                    {/* Container to render messages in a project */}
                </Suspense>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
                defaultSize={65}
                minSize={50}
            >
                <Tabs
                    className="h-full gap-y-0"
                    defaultValue="preview"
                    value={tabState}
                    onValueChange={(value) => setTabState(value as "preview" | "code")}
                >
                    <div className="w-full flex items-center p-2 border-b gap-x-2">
                        <TabsList className="h-8 p-0 border rounded-md">
                            <TabsTrigger value="preview" className="rounded-md">
                                <EyeIcon /> <span>Demo</span>
                            </TabsTrigger>
                            <TabsTrigger value="code" className="rounded-md">
                                <CodeIcon /> <span>Code</span>
                            </TabsTrigger>
                        </TabsList>
                        <div className="ml-auto flex items-center gap-x-2">
                            <Button asChild variant="default" size="sm">
                                <Link href="/pricing">
                                    <CrownIcon /> Upgrade
                                </Link>
                            </Button>
                        </div>
                    </div>
                    <TabsContent value="preview">
                        {!!activeFragment && <FragmentWeb data={activeFragment} />}
                    </TabsContent>
                    <TabsContent value="code" className="min-h-0">
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
