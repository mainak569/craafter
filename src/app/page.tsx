"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/client";

import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useState } from "react";

const Page = () => {
  const [value, setValue] = useState("");

  const trpc = useTRPC();
  const{data: messages} = useQuery(trpc.messages.getMany.queryOptions());
  const createMessage = useMutation(trpc.messages.create.mutationOptions({
    onSuccess: ()=> {
      toast.success("Message created successfully!");
    }
  }));

  return (
    <div className="p-4 max-w-7xl mx-auto bg-black text-white w-full h-screen">
      <Input value={value} onChange={(e) => setValue(e.target.value)} />
      <Button 
        disabled={createMessage.isPending} 
        onClick={() => createMessage.mutate({ value: value })}
      >
          Invoke background job
      </Button>
      {JSON.stringify(messages, null, 2)}
    </div>
  );
};

export default Page;