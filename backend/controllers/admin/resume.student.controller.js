const { ObjectId } = require("mongodb");
const { getDB } = require("../../config/db");
const { isWithinExamHoursIST } = require("../../helper/ist_converter");

// ============================================================
// RESUME STUDENT EXAM CONTROLLER (FOR ADMIN / STAFF)
// ============================================================
const resumeStudentExam = async (req, res) => {
  try {
    const { username, questionCode } = req.body;

    if (!username || !String(username).trim()) {
      return res.status(400).json({
        success: false,
        message: "Student username (admission/register number) is required.",
      });
    }

    if (!questionCode || !String(questionCode).trim()) {
      return res.status(400).json({
        success: false,
        message: "Question code is required.",
      });
    }

    if (!isWithinExamHoursIST()) {
      return res.status(403).json({
        success: false,
        message:
          "Exams can only be resumed during exam hours (8:30 AM to 5:00 PM IST).",
      });
    }

    const cleanUsername = String(username).trim();
    const cleanQuestionCode = String(questionCode).trim().toUpperCase();
    const db = getDB();

    // 1. Find student by username, admissionNo, or registerNo
    const student = await db.collection("students").findOne({
      $or: [
        { username: cleanUsername },
        { admissionNo: cleanUsername },
        { registerNo: cleanUsername },
      ],
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: `Student "${cleanUsername}" not found.`,
      });
    }

    // 2. Find Question Set by questionCode (case-insensitive)
    const questionSet = await db.collection("questions").findOne({
      $or: [
        { questionCode: cleanQuestionCode },
        { questionCode: { $regex: new RegExp(`^${cleanQuestionCode}$`, "i") } },
      ],
    });

    // 3. Find matching schedules by questionSetId or testcode
    const scheduleQuery = {
      $or: [
        { testcode: cleanQuestionCode },
        { testcode: { $regex: new RegExp(`^${cleanQuestionCode}$`, "i") } },
        ...(questionSet ? [{ questionSetId: questionSet._id }] : []),
      ],
    };
    const matchingSchedules = await db.collection("schedule").find(scheduleQuery).toArray();
    const matchingScheduleIds = matchingSchedules.map((s) => s._id);

    // 4. Find exam attempt for this student matching questionCode
    const examFilter = {
      admissionNo: student.admissionNo,
      $or: [
        { questionCode: cleanQuestionCode },
        { questionCode: { $regex: new RegExp(`^${cleanQuestionCode}$`, "i") } },
        ...(questionSet ? [{ questionSetId: questionSet._id }] : []),
        ...(matchingScheduleIds.length > 0 ? [{ testId: { $in: matchingScheduleIds } }] : []),
      ],
    };

    const targetExam = await db.collection("exam").findOne(examFilter);

    if (!targetExam) {
      return res.status(404).json({
        success: false,
        message: `No exam attempt found for student ${student.name || cleanUsername} (${student.admissionNo}) with Question Code "${cleanQuestionCode}".`,
      });
    }

    // 5. Check Malpractice: do not resume if malpractice
    const malpracticeCount = await db.collection("malpractice").countDocuments({
      admissionNo: student.admissionNo,
      testId: targetExam.testId,
    });

    if (
      targetExam.result === "Malpractice" ||
      targetExam.malpractice?.status === true ||
      malpracticeCount >= 3
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot resume exam: Student ${student.name || cleanUsername} (${student.admissionNo}) was disqualified due to malpractice for Question Code "${cleanQuestionCode}".`,
        result: "Malpractice",
      });
    }

    // 6. Check if exam is already submitted/completed
    if (targetExam.status === false) {
      return res.status(400).json({
        success: false,
        message: `Exam for Question Code "${cleanQuestionCode}" has already been submitted and completed by ${student.name || cleanUsername}.`,
      });
    }

    // 7. Check if scheduled test is completed
    const scheduledTest = await db.collection("schedule").findOne({
      _id: targetExam.testId,
    });

    if (scheduledTest && scheduledTest.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: "This test has already been completed and cannot be resumed.",
      });
    }

    // 8. Mark exam attempt and student as allowed to resume (one-time use)
    await db.collection("exam").updateOne(
      { _id: targetExam._id },
      {
        $set: {
          status: true,
          result: "Pending",
          allowResume: true,
          resumedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    await db.collection("students").updateOne(
      { _id: student._id },
      {
        $set: {
          allowResume: true,
          resumedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: `Exam for Question Code "${cleanQuestionCode}" successfully unlocked for ${student.name || cleanUsername} (${student.admissionNo}). Student can now resume their exam.`,
      student: {
        name: student.name,
        admissionNo: student.admissionNo,
        username: student.username,
      },
      questionCode: cleanQuestionCode,
      testId: targetExam.testId,
      testCode: scheduledTest?.testcode || null,
    });
  } catch (error) {
    console.error("RESUME STUDENT EXAM ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to resume student exam.",
      error: error.message || "Unexpected server error.",
    });
  }
};

module.exports = {
  resumeStudentExam,
};
