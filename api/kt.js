export default async function handler(req, res) {
  try {
    res.status(200).json({
      status: "ok",
      message: "API hoạt động",
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({
      status: "error",
      message: e.message
    });
  }
}
