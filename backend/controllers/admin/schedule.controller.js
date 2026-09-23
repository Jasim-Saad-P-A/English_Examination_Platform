const { ObjectId } = require("mongodb");
const crypto = require("crypto");
const { getDB } = require("../../config/db");
const { toIST } = require("../../helper/ist_converter");

// ============================================================
// GENERATE UNIQUE TEST CODE HELPER
// ============================================================
const generateUniqueTestCode = async (db) => {
  const characters = "1234567890";
  while (true) {
    const bytes = crypto.randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += characters[bytes[i] % characters.length];
    }
    const existing = await db.collection("schedule").findOne({
      testcode: code,
    });
    if (!existing) {
      return code;
    }
  }
};

const scheduleExam = async (req, res) => {
  try {
    const {
      category,
      cie,
      questionSetId,
      department,
      batch,
      academicYear,
      semester,
      section,
      admissionNo,
      date,
      duration,
      startTime,
      endTime,
    } = req.body;

    // =====================================================
    // CATEGORY VALIDATION
    // =====================================================
    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Category is required.",
      });
    }

    const allowedCategories = ["university", "normal", "retest"];
    const normalizedCategory = String(category).trim().toLowerCase();

    if (!allowedCategories.includes(normalizedCategory)) {
      return res.status(400).json({
        success: false,
        message: "Category must be university, normal or retest.",
      });
    }

    // =====================================================
    // COMMON REQUIRED FIELD VALIDATION
    // =====================================================
    if (
      !questionSetId ||
      !batch ||
      !academicYear ||
      !semester ||
      !duration ||
      !department ||
      !section
    ) {
      return res.status(400).json({
        success: false,
        message:
          "questionSetId, batch, academicYear, semester, duration, department and section are required.",
      });
    }

    // For non-normal categories, startTime and endTime are required
    if (normalizedCategory !== "normal") {
      if (!startTime || !endTime) {
        return res.status(400).json({
          success: false,
          message:
            "startTime and endTime are required for this category.",
        });
      }
    }

    // =====================================================
    // UNIVERSITY RESTRICTION & CIE VALIDATION
    // =====================================================
    if (normalizedCategory === "university") {
      if (req.user?.role !== "admin") {
        return res.status(403).json({
          success: false,
          message:
            "University examinations can only be scheduled by administrators.",
        });
      }
    }

    const allowedCIE = ["I", "II", "III"];
    let normalizedCIE = null;

    // No CIE for University category
    if (normalizedCategory !== "university" && cie !== undefined && cie !== null && cie !== "") {
      normalizedCIE = String(cie).trim().toUpperCase();
      if (!allowedCIE.includes(normalizedCIE)) {
        return res.status(400).json({
          success: false,
          message: "CIE must be I, II or III.",
        });
      }
    }

    // CIE REQUIRED FOR NORMAL CATEGORY
    if (normalizedCategory === "normal" && !normalizedCIE) {
      return res.status(400).json({
        success: false,
        message: "CIE is required for normal examination.",
      });
    }

    // =====================================================
    // ACADEMIC YEAR VALIDATION
    // =====================================================
    const normalizedAcademicYear = String(academicYear).trim();
    if (!/^\d{4}-\d{4}$/.test(normalizedAcademicYear)) {
      return res.status(400).json({
        success: false,
        message:
          "Academic year must be in format YYYY-YYYY. Example: 2024-2028.",
      });
    }

    // =====================================================
    // SEMESTER VALIDATION
    // =====================================================
    const normalizedSemester = String(semester).trim().toLowerCase();
    if (normalizedSemester !== "odd" && normalizedSemester !== "even") {
      return res.status(400).json({
        success: false,
        message: "Semester must be odd or even.",
      });
    }

    // =====================================================
    // ADMISSION NUMBER VALIDATION
    // =====================================================
    if (
      admissionNo !== undefined &&
      admissionNo !== null &&
      !Array.isArray(admissionNo)
    ) {
      return res.status(400).json({
        success: false,
        message: "admissionNo must be an array.",
      });
    }

    if (
      (normalizedCategory === "retest" || normalizedCategory === "university") &&
      (!admissionNo || admissionNo.length === 0)
    ) {
      return res.status(400).json({
        success: false,
        message: `Admission numbers are required for ${normalizedCategory}.`,
      });
    }

    // =====================================================
    // DURATION VALIDATION
    // =====================================================
    const durationNumber = Number(duration);
    if (!Number.isInteger(durationNumber) || durationNumber <= 0) {
      return res.status(400).json({
        success: false,
        message: "Duration must be a positive number in minutes.",
      });
    }

    // =====================================================
    // DATABASE & QUESTION SET VALIDATION
    // =====================================================
    const db = getDB();

    if (!ObjectId.isValid(questionSetId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Question Set ID.",
      });
    }

    const questionObjectId = new ObjectId(questionSetId);
    const questionSet = await db.collection("questions").findOne({
      _id: questionObjectId,
    });

    if (!questionSet) {
      return res.status(404).json({
        success: false,
        message: "Question set not found.",
      });
    }

    const examType = questionSet.type || "audio";
    const minAudioDuration = Math.ceil(
      Number(questionSet.audioDurationMinutes || questionSet.duration || 0)
    );
    if (examType === "audio" && minAudioDuration > 0 && durationNumber < minAudioDuration) {
      return res.status(400).json({
        success: false,
        message: `Duration must be at least ${minAudioDuration} minutes (question audio duration).`,
      });
    }

    // Auto-resolve CIE for retest if not explicitly provided
    if (normalizedCategory === "retest" && !normalizedCIE) {
      const normalSchedule = await db.collection("schedule").findOne({
        questionSetId: questionObjectId,
        cie: { $in: ["I", "II", "III", "i", "ii", "iii"] },
        status: { $nin: ["Cancelled", "cancelled"] },
      });
      if (normalSchedule?.cie) {
        normalizedCIE = String(normalSchedule.cie).trim().toUpperCase();
      }
    }

    // =====================================================
    // TIMING VALIDATION (FOR RETEST & UNIVERSITY)
    // =====================================================
    let start = null;
    let end = null;

    if (normalizedCategory !== "normal") {
      start = new Date(`${startTime}+05:30`);
      end = new Date(`${endTime}+05:30`);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid startTime or endTime.",
        });
      }

      if (end <= start) {
        return res.status(400).json({
          success: false,
          message: "End time must be greater than start time.",
        });
      }
    }

    const normalizedSection = String(section).trim().toUpperCase();
    const allowedSections = ["A", "B", "C", "D"];

    if (!allowedSections.includes(normalizedSection)) {
      return res.status(400).json({
        success: false,
        message: "Section must be A, B, C or D.",
      });
    }

    const assignedFaculty = await db.collection("staff").findOne({
      role: "staff",
      allowdept: {
        $elemMatch: {
          batch: String(batch).trim(),
          classes: {
            $elemMatch: {
              dept: String(department).trim(),
              sec: normalizedSection,
            },
          },
        },
      },
    });

    if (!assignedFaculty) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot schedule exam: No staff member is currently assigned to this batch, department, and section.",
      });
    }

    let finalAdmissionNos = Array.isArray(admissionNo) ? [...admissionNo] : [];
    if (
      finalAdmissionNos.length === 0 &&
      !["retest", "university"].includes(normalizedCategory)
    ) {
      const classStudents = await db
        .collection("students")
        .find({
          batch: String(batch).trim(),
          department: String(department).trim(),
          section: normalizedSection,
        })
        .project({ admissionNo: 1, username: 1 })
        .toArray();

      const allAdmissions = classStudents
        .flatMap((s) => [s.admissionNo, s.username])
        .filter(Boolean);

      finalAdmissionNos = [...new Set(allAdmissions)];
    }

    // Restrict schedule strictly for same student, category, semester, question set, class, and academic year
    if (finalAdmissionNos.length > 0) {
      const studentDupQuery = {
        category: normalizedCategory,
        questionSetId: questionObjectId,
        "eligibility.department": String(department).trim(),
        "eligibility.batch": String(batch).trim(),
        "eligibility.academicYear": normalizedAcademicYear,
        "eligibility.semester": normalizedSemester,
        "eligibility.section": normalizedSection,
        "eligibility.admissionNo": { $in: finalAdmissionNos },
        status: { $ne: "Cancelled" },
      };

      const existingStudentExams = await db
        .collection("schedule")
        .find(studentDupQuery)
        .toArray();

      if (existingStudentExams.length > 0) {
        const conflictingAdmissions = new Set();
        existingStudentExams.forEach((ex) => {
          (ex.eligibility?.admissionNo || []).forEach((adm) => {
            if (finalAdmissionNos.includes(adm)) {
              conflictingAdmissions.add(adm);
            }
          });
        });

        if (conflictingAdmissions.size > 0) {
          const studentList = [...conflictingAdmissions];
          const preview = studentList.slice(0, 5).join(", ");
          const moreCount =
            studentList.length > 5 ? ` and ${studentList.length - 5} more` : "";
          return res.status(409).json({
            success: false,
            message: `This test is already assigned to student(s): ${preview}${moreCount} for category (${normalizedCategory}), semester (${normalizedSemester}), class (${department} - Sec ${normalizedSection}), and academic year (${normalizedAcademicYear}).`,
          });
        }
      }
    } else {
      // Whole-class duplicate check when no individual admission numbers exist
      const classDupQuery = {
        category: normalizedCategory,
        questionSetId: questionObjectId,
        "eligibility.department": String(department).trim(),
        "eligibility.batch": String(batch).trim(),
        "eligibility.academicYear": normalizedAcademicYear,
        "eligibility.semester": normalizedSemester,
        "eligibility.section": normalizedSection,
        status: { $ne: "Cancelled" },
      };

      const existingClassExam = await db
        .collection("schedule")
        .findOne(classDupQuery);

      if (existingClassExam) {
        return res.status(409).json({
          success: false,
          message: `This test is already scheduled for ${department} Section ${normalizedSection} for category (${normalizedCategory}), semester (${normalizedSemester}), and academic year (${normalizedAcademicYear}).`,
        });
      }
    }

    const examDate = date
      ? String(date).trim()
      : startTime
        ? String(startTime).split("T")[0]
        : null;

    let testcode = null;
    let testcodeGeneratedAt = null;
    const now = new Date();

    if (normalizedCategory === "normal") {
      testcode = await generateUniqueTestCode(db);
      testcodeGeneratedAt = now;
    }

    const exam = {
      category: normalizedCategory,
      type: examType,
      cie: normalizedCIE,
      questionSetId: questionObjectId,
      inchargeStaff: assignedFaculty.name,
      eligibility: {
        department: String(department).trim(),
        batch: String(batch).trim(),
        academicYear: normalizedAcademicYear,
        semester: normalizedSemester,
        section: normalizedSection,
        admissionNo: finalAdmissionNos,
      },
      duration: durationNumber,
      date: examDate,
      startTime: start,
      endTime: end,
      status: "Scheduled",
      testcode,
      testcodeGeneratedAt,
      createdBy: req.user?.username || null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("schedule").insertOne(exam);

    return res.status(201).json({
      success: true,
      message: "Exam scheduled successfully.",
      examId: result.insertedId,
      exam,
    });
  } catch (error) {
    console.error("Schedule Exam Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to schedule exam.",
      error: error.message || "Unexpected server error.",
    });
  }
};

module.exports = {
  scheduleExam,
};
