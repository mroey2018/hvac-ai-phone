app.post("/tools/workiz_create_job", async (req, res) => {

  const { name, city, address, phone, email, tonnage } = req.body;

  try {

    const response = await fetch("https://api.workiz.com/job/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-token": process.env.WORKIZ_API_TOKEN,
        "api-secret": process.env.WORKIZ_API_SECRET
      },
      body: JSON.stringify({
        FirstName: name,
        Phone: phone,
        Email: email,
        Address: address,
        City: city,
        JobType: "AC Estimate",
        JobDescription: `Requested system: ${tonnage}`
      })
    });

    const data = await response.json();

    console.log("Workiz job created:", data);

    res.json({ success: true, workiz: data });

  } catch (error) {

    console.error("Workiz job error:", error);

    res.status(500).json({ error: "Failed to create job" });

  }

});
