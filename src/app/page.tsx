"use client";

import { useMutation } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const Page = () => {
  const trpc = useTRPC();
  const invoke = useMutation(trpc.invoke.mutationOptions({
    onSuccess: ()=> {
      toast.success("Background job invoked successfully!");
    }
  }));

  return (
    <div className="p-4 max-w-7xl mx-auto bg-black text-white w-full h-screen">
      <Button disabled={invoke.isPending} onClick={() => invoke.mutate({ text: "Mainak13" })}>
        Invoke Background Job
      </Button>
    </div>
  );
};

export default Page;