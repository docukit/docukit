"use server";

import nodemailer from "nodemailer";
import { env } from "@/env";
import { z } from "zod";

const contactFormSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  message: z.string().min(10, "Message must be at least 10 characters"),
});

export type ContactFormState = {
  success?: boolean;
  error?: string;
  errors?: { name?: string[]; email?: string[]; message?: string[] };
};

export async function sendContactEmail(
  _prevState: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const rawData = {
    name: formData.get("name"),
    email: formData.get("email"),
    message: formData.get("message"),
  };

  // Validate form data
  const parsed = contactFormSchema.safeParse(rawData);

  if (!parsed.success) {
    return {
      success: false,
      error: "Please fix the errors below",
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const { name, email, message } = parsed.data;

  try {
    // Create transporter using SMTP URL
    const transporter = nodemailer.createTransport(env.SMTP_URL);

    // Get sender email from SMTP URL for the "from" field
    const smtpUrl = new URL(env.SMTP_URL);
    const fromEmail = smtpUrl.username
      ? `${smtpUrl.username}@${smtpUrl.hostname.replace("smtp.", "")}`
      : env.CONTACT_EMAIL_TO;

    // Send email
    await transporter.sendMail({
      from: `"${name} via Contact Form" <${fromEmail}>`,
      to: env.CONTACT_EMAIL_TO,
      replyTo: email,
      subject: `Contact Form: Message from ${name}`,
      text: message,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">New Contact Form Submission</h2>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 10px 0;"><strong>From:</strong> ${name}</p>
            <p style="margin: 10px 0;"><strong>Email:</strong> ${email}</p>
          </div>
          <div style="background-color: #fff; padding: 20px; border: 1px solid #ddd; border-radius: 5px;">
            <h3 style="color: #666; margin-top: 0;">Message:</h3>
            <p style="color: #333; line-height: 1.6;">${message.replace(/\n/g, "<br>")}</p>
          </div>
        </div>
      `,
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to send email:", error);
    return {
      success: false,
      error: "Failed to send message. Please try again later.",
    };
  }
}
