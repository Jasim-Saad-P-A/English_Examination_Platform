const { ObjectId } = require("mongodb");
const { getDB } = require("../../config/db");
const { autoSubmitExam } = require("../exam_cron/exam.cron.controller");
const {
  generateAndSaveClassReportForSchedule,
} = require("../../service/class_report.service");

// ============================================================
// END SCHEDULED EXAM CONTROLLER
// ============================================================
const endScheduledExam = async (req, res) => {
  try {
    const { testId } = req.body;

    // =====================================================
    // VALIDATION
    // =====================================================
    if (!testId) {
      return res.status(400).json({
        success: false,
        message: "testId is required.",
      });
    }

    if (!ObjectId.isValid(testId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid testId.",
      });
    }

    const db = getDB();
    const testObjectId = new ObjectId(testId);

    // =====================================================
    // FIND SCHEDULED EXAM
    // =====================================================
    const exam = await db.collection("schedule").findOne({
      _id: testObjectId,
    });

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Scheduled exam not found.",
      });
    }

    if (exam.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: "Exam is already completed.",
      });
    }

    // =====================================================
    // 1. AUTO SUBMIT ANY ACTIVE STUDENT ATTEMPTS
    // =====================================================
    const activeAttempts = await db
      .collection("exam")
      .find({
        testId: { $in: [testObjectId, String(testId)] },
        status: true,
      })
      .toArray();

    console.log(
      `[END TEST] Auto-submitting ${activeAttempts.length} active attempts for test ${testId}`
    );

    for (const attempt of activeAttempts) {
      await autoSubmitExam(db, attempt, exam);
    }

    // =====================================================
    // 2. MARK SCHEDULE AS COMPLETED
    // =====================================================
    const now = new Date();
    await db.collection("schedule").updateOne(
      { _id: testObjectId },
      {
        $set: {
          status: "Completed",
          completedAt: now,
          endTime: exam.endTime || now,
          updatedAt: now,
        },
      }
    );

    console.log(`[END TEST] Exam ${testId} marked as Completed.`);

    await db.collection("exam").updateMany(
      { testId: { $in: [testObjectId, String(testId)] } },
      { $set: { allowResume: false } }
    );

    // =====================================================
    // 3. TRIGGER CLASS CIE REPORT GENERATION IN RESULT COLLECTION
    // =====================================================
    generateAndSaveClassReportForSchedule(testObjectId).catch((err) => {
      console.error(
        `[END TEST] Error generating class report for test ${testId}:`,
        err.message
      );
    });

    return res.status(200).json({
      success: true,
      message:
        "Exam ended successfully. Class report updated in result collection.",
      testId,
    });
  } catch (error) {
    console.error("END SCHEDULED EXAM ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to end scheduled exam.",
      error: error.message || "Unexpected server error.",
    });
  }
};

module.exports = {
  endScheduledExam,
};
