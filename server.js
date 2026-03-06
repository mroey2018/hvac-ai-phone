import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 10000);

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/tools/workiz_create_job", async (req, res) => {
  try {
    const toolSecret = req.get("x-tool-secret");

    if (!process.env.TOOL_SECRET || toolSecret !== process.env.TOOL_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const {
      name,
      city,
      address,
      phone,
      email,
      tonnage,
      day,
      time
    } = req.body || {};

    const response = await fetch("https://api.workiz.com/job/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-token": process.env.WORKIZ_API_TOKEN,
        "api-secret": process.env.WORKIZ_API_SECRET
      },
      body: JSON.stringify({
        FirstName: name || "",
        Phone: phone || "",
        Email: email || "",
        Address: address || "",
        City: city || "",
        JobType: "AC Estimate",
        JobDescription: `New AC estimate request. Tonnage: ${tonnage || "Not provided"}. Preferred day: ${day || "Not provided"}. Preferred time: ${time || "Not provided"}.`
      })
    });

    const data = await response.json();

    console.log("Workiz job created:", data);

    return res.status(200).json({
      success: !data?.error,
      workiz: data
    });
  } catch (error) {
    console.error("Workiz job error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create job"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server started and listening on", PORT);
});
