"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  sendContactEmail,
  type ContactFormState,
} from "@/app/actions/send-contact-email";

const initialState: ContactFormState = {};

export default function ContactPage() {
  const [state, formAction, isPending] = useActionState(
    sendContactEmail,
    initialState,
  );

  // Controlled form fields to prevent clearing on validation errors
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  if (state.success === true && name !== "") {
    setName("");
    setEmail("");
    setMessage("");
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-16">
      <div className="mb-8">
        <h1 className="mb-4 text-4xl font-bold">Contact Us</h1>
        <p className="text-muted-foreground text-lg">
          Have a question or feedback? We'd love to hear from you.
        </p>
      </div>

      <form id="contact-form" action={formAction} className="space-y-6">
        {/* Name Field */}
        <div className="space-y-2">
          <Label htmlFor="name">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Your name"
            required
            disabled={isPending}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={state.errors?.name ? "true" : "false"}
            aria-describedby={state.errors?.name ? "name-error" : undefined}
          />
          {state.errors?.name && (
            <p id="name-error" className="text-destructive text-sm">
              {state.errors.name[0]}
            </p>
          )}
        </div>

        {/* Email Field */}
        <div className="space-y-2">
          <Label htmlFor="email">
            Email <span className="text-destructive">*</span>
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="your.email@example.com"
            required
            disabled={isPending}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={state.errors?.email ? "true" : "false"}
            aria-describedby={state.errors?.email ? "email-error" : undefined}
          />
          {state.errors?.email && (
            <p id="email-error" className="text-destructive text-sm">
              {state.errors.email[0]}
            </p>
          )}
        </div>

        {/* Message Field */}
        <div className="space-y-2">
          <Label htmlFor="message">
            Message <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="message"
            name="message"
            placeholder="Your message..."
            rows={6}
            required
            disabled={isPending}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-invalid={state.errors?.message ? "true" : "false"}
            aria-describedby={
              state.errors?.message ? "message-error" : undefined
            }
          />
          {state.errors?.message && (
            <p id="message-error" className="text-destructive text-sm">
              {state.errors.message[0]}
            </p>
          )}
        </div>

        {/* Success Message */}
        {state.success && (
          <div className="bg-primary/10 text-primary border-primary/20 rounded-md border p-4">
            <p className="font-medium">Message sent successfully!</p>
            <p className="text-sm">
              We'll get back to you as soon as possible.
            </p>
          </div>
        )}

        {/* Error Message */}
        {state.error && !state.success && (
          <div className="bg-destructive/10 text-destructive border-destructive/20 rounded-md border p-4">
            <p className="font-medium">{state.error}</p>
          </div>
        )}

        {/* Submit Button */}
        <Button type="submit" disabled={isPending} className="w-full" size="lg">
          {isPending ? "Sending..." : "Send Message"}
        </Button>
      </form>
    </main>
  );
}
