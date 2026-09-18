/**
 * CAIE + IB syllabus topic trees.
 *
 * Used by the Gemini extraction prompt to classify questions into real syllabus
 * topics (e.g. "B5.1 Homeostasis") instead of vague labels like "General".
 *
 * Each entry is { code, topic } where code is the syllabus section reference.
 * Gemini picks the closest match; if none fit, it falls back to "General".
 *
 * Sources: official CAIE syllabus documents (2022-2025) + IB subject guides.
 */

export type SyllabusTopic = { code: string; topic: string };

export const SYLLABUS: Record<string, SyllabusTopic[]> = {
  // -----------------------------------------------------------------------
  // CAIE IGCSE
  // -----------------------------------------------------------------------
  "0610": [ // Biology
    { code: "B1", topic: "Characteristics of living organisms" },
    { code: "B2", topic: "Cells" },
    { code: "B2.1", topic: "Cell structure" },
    { code: "B2.2", topic: "Cell organisation" },
    { code: "B3", topic: "Biological molecules" },
    { code: "B3.1", topic: "Carbohydrates, lipids, proteins" },
    { code: "B3.2", topic: "DNA" },
    { code: "B4", topic: "Enzymes" },
    { code: "B5", topic: "Nutrition" },
    { code: "B5.1", topic: "Plant nutrition (photosynthesis)" },
    { code: "B5.2", topic: "Human nutrition (diet, digestion)" },
    { code: "B6", topic: "Transport in organisms" },
    { code: "B6.1", topic: "Transport in plants (xylem, phloem)" },
    { code: "B6.2", topic: "Transport in humans (blood, heart)" },
    { code: "B7", topic: "Coordination and response" },
    { code: "B7.1", topic: "Nervous system" },
    { code: "B7.2", topic: "Hormones" },
    { code: "B7.3", topic: "Homeostasis" },
    { code: "B8", topic: "Reproduction" },
    { code: "B8.1", topic: "Plant reproduction" },
    { code: "B8.2", topic: "Human reproduction" },
    { code: "B8.3", topic: "Inheritance and genetics" },
    { code: "B9", topic: "Organisms and environment" },
    { code: "B9.1", topic: "Food chains, food webs" },
    { code: "B9.2", topic: "Ecology, ecosystems" },
    { code: "B9.3", topic: "Human impacts on environment" },
    { code: "B10", topic: "Biotechnology and genetic engineering" },
    { code: "B11", topic: "Disease and immunity" },
    { code: "B12", topic: "Respiration" },
    { code: "B13", topic: "Excretion" },
  ],
  "0620": [ // Chemistry
    { code: "C1", topic: "States of matter" },
    { code: "C2", topic: "Atoms, elements, compounds" },
    { code: "C2.1", topic: "Atomic structure" },
    { code: "C2.2", topic: "Periodic Table" },
    { code: "C3", topic: "Chemical bonding" },
    { code: "C3.1", topic: "Ionic bonding" },
    { code: "C3.2", topic: "Covalent bonding" },
    { code: "C3.3", topic: "Metallic bonding" },
    { code: "C4", topic: "Stoichiometry (moles)" },
    { code: "C5", topic: "Chemical reactions" },
    { code: "C5.1", topic: "Acids, bases, salts" },
    { code: "C5.2", topic: "Oxidation and reduction" },
    { code: "C5.3", topic: "Rates of reaction" },
    { code: "C5.4", topic: "Reversible reactions, equilibrium" },
    { code: "C6", topic: "Electrolysis" },
    { code: "C7", topic: "Energy changes in reactions" },
    { code: "C8", topic: "Organic chemistry" },
    { code: "C8.1", topic: "Hydrocarbons (alkanes, alkenes)" },
    { code: "C8.2", topic: "Alcohols, carboxylic acids" },
    { code: "C8.3", topic: "Polymers" },
    { code: "C9", topic: "Metals" },
    { code: "C9.1", topic: "Extraction of metals" },
    { code: "C9.2", topic: "Reactivity series" },
    { code: "C10", topic: "Atmosphere and environment" },
    { code: "C11", topic: "Chemical analysis (tests for ions)" },
    { code: "C12", topic: "Fuels and Earth science" },
  ],
  "0625": [ // Physics
    { code: "P1", topic: "Motion (speed, velocity, acceleration)" },
    { code: "P1.1", topic: "Kinematics (graphs, equations)" },
    { code: "P2", topic: "Forces" },
    { code: "P2.1", topic: "Newton's laws" },
    { code: "P2.2", topic: "Friction, air resistance" },
    { code: "P2.3", topic: "Centre of mass, stability" },
    { code: "P2.4", topic: "Momentum" },
    { code: "P3", topic: "Energy" },
    { code: "P3.1", topic: "Energy stores and transfers" },
    { code: "P3.2", topic: "Work, power" },
    { code: "P3.3", topic: "Energy resources" },
    { code: "P4", topic: "Waves" },
    { code: "P4.1", topic: "Wave properties" },
    { code: "P4.2", topic: "Light (reflection, refraction)" },
    { code: "P4.3", topic: "Sound" },
    { code: "P4.4", topic: "Electromagnetic spectrum" },
    { code: "P5", topic: "Electricity" },
    { code: "P5.1", topic: "Circuit elements, Ohm's law" },
    { code: "P5.2", topic: "Series and parallel circuits" },
    { code: "P5.3", topic: "Electrical safety, power" },
    { code: "P5.4", topic: "Electrostatics" },
    { code: "P6", topic: "Magnetism" },
    { code: "P6.1", topic: "Magnets, magnetic fields" },
    { code: "P6.2", topic: "Electromagnetism" },
    { code: "P6.3", topic: "Electromagnetic induction" },
    { code: "P6.4", topic: "Transformers" },
    { code: "P7", topic: "Thermal physics" },
    { code: "P7.1", topic: "Heat transfer (conduction, convection, radiation)" },
    { code: "P7.2", topic: "States of matter, gas laws" },
    { code: "P8", topic: "Radioactivity" },
    { code: "P8.1", topic: "Atomic model" },
    { code: "P8.2", topic: "Nuclear decay, half-life" },
    { code: "P8.3", topic: "Nuclear fission, fusion" },
    { code: "P9", topic: "Space physics (solar system, stars)" },
    { code: "P10", topic: "Gravitation" },
    { code: "P11", topic: "Pressure" },
  ],
  "0580": [ // Mathematics
    { code: "M1", topic: "Number" },
    { code: "M1.1", topic: "Integers, place value" },
    { code: "M1.2", topic: "Fractions, decimals, percentages" },
    { code: "M1.3", topic: "Ratio, proportion" },
    { code: "M1.4", topic: "Powers, roots, standard form" },
    { code: "M2", topic: "Algebra" },
    { code: "M2.1", topic: "Expressions, equations" },
    { code: "M2.2", topic: "Inequalities" },
    { code: "M2.3", topic: "Sequences" },
    { code: "M2.4", topic: "Functions" },
    { code: "M3", topic: "Coordinate geometry" },
    { code: "M3.1", topic: "Straight-line graphs" },
    { code: "M3.2", topic: "Curves, transformations" },
    { code: "M4", topic: "Geometry" },
    { code: "M4.1", topic: "Angles, constructions" },
    { code: "M4.2", topic: "Congruence, similarity" },
    { code: "M4.3", topic: "Symmetry" },
    { code: "M5", topic: "Mensuration" },
    { code: "M5.1", topic: "Perimeter, area, volume" },
    { code: "M5.2", topic: "Trigonometry" },
    { code: "M6", topic: "Vectors and transformations" },
    { code: "M7", topic: "Probability" },
    { code: "M8", topic: "Statistics" },
    { code: "M8.1", topic: "Data representation" },
    { code: "M8.2", topic: "Mean, median, mode" },
  ],
  "0606": [ // Additional Mathematics
    { code: "A1", topic: "Functions and graphs" },
    { code: "A2", topic: "Quadratic functions" },
    { code: "A3", topic: "Polynomials and equations" },
    { code: "A4", topic: "Simultaneous equations" },
    { code: "A5", topic: "Indices and surds" },
    { code: "A6", topic: "Logarithmic and exponential functions" },
    { code: "A7", topic: "Straight-line geometry" },
    { code: "A8", topic: "Coordinate geometry of circles" },
    { code: "A9", topic: "Trigonometry" },
    { code: "A10", topic: "Differentiation" },
    { code: "A11", topic: "Integration" },
    { code: "A12", topic: "Vectors" },
    { code: "A13", topic: "Permutations and combinations" },
    { code: "A14", topic: "Binomial expansion" },
    { code: "A15", topic: "Kinematics" },
  ],

  // -----------------------------------------------------------------------
  // CAIE A-Level
  // -----------------------------------------------------------------------
  "9709": [ // Mathematics A-Level
    { code: "P1", topic: "Pure Mathematics 1" },
    { code: "P1.1", topic: "Quadratics" },
    { code: "P1.2", topic: "Functions" },
    { code: "P1.3", topic: "Coordinate geometry" },
    { code: "P1.4", topic: "Circular measure" },
    { code: "P1.5", topic: "Trigonometry" },
    { code: "P1.6", topic: "Vectors" },
    { code: "P1.7", topic: "Series" },
    { code: "P1.8", topic: "Differentiation" },
    { code: "P1.9", topic: "Integration" },
    { code: "P2", topic: "Pure Mathematics 2" },
    { code: "P2.1", topic: "Logarithmic and exponential functions" },
    { code: "P2.2", topic: "Algebra" },
    { code: "P2.3", topic: "Numerical iteration" },
    { code: "M1", topic: "Mechanics 1" },
    { code: "M1.1", topic: "Forces, equilibrium" },
    { code: "M1.2", topic: "Kinematics" },
    { code: "M1.3", topic: "Newton's laws of motion" },
    { code: "M1.4", topic: "Momentum" },
    { code: "M1.5", topic: "Energy, work, power" },
    { code: "S1", topic: "Statistics 1" },
    { code: "S1.1", topic: "Representation of data" },
    { code: "S1.2", topic: "Measures of central tendency" },
    { code: "S1.3", topic: "Probability" },
    { code: "S1.4", topic: "Permutations, combinations" },
    { code: "S1.5", topic: "Discrete random variables" },
    { code: "S1.6", topic: "Normal distribution" },
  ],
  "9702": [ // Physics A-Level
    { code: "PH1", topic: "Physical quantities and units" },
    { code: "PH2", topic: "Kinematics" },
    { code: "PH3", topic: "Dynamics (Newton's laws)" },
    { code: "PH4", topic: "Forces, equilibrium" },
    { code: "PH5", topic: "Work, energy, power" },
    { code: "PH6", topic: "Momentum" },
    { code: "PH7", topic: "Deformation of solids" },
    { code: "PH8", topic: "Waves" },
    { code: "PH8.1", topic: "Progressive waves" },
    { code: "PH8.2", topic: "Stationary waves" },
    { code: "PH8.3", topic: "Diffraction, interference" },
    { code: "PH9", topic: "Superposition" },
    { code: "PH10", topic: "Electric fields" },
    { code: "PH11", topic: "DC circuits" },
    { code: "PH12", topic: "Capacitance" },
    { code: "PH13", topic: "Magnetic fields" },
    { code: "PH14", topic: "Electromagnetic induction" },
    { code: "PH15", topic: "Alternating currents" },
    { code: "PH16", topic: "Thermal physics" },
    { code: "PH17", topic: "Ideal gases" },
    { code: "PH18", topic: "Quantum physics" },
    { code: "PH19", topic: "Nuclear physics" },
    { code: "PH20", topic: "Circular motion" },
    { code: "PH21", topic: "Gravitational fields" },
    { code: "PH22", topic: "Oscillations (SHM)" },
    { code: "PH23", topic: "Astronomy, cosmology" },
    { code: "PH24", topic: "Medical imaging" },
    { code: "PH25", topic: "Communication systems" },
  ],
};

/**
 * Get the syllabus topic list for a subject code.
 * Returns null if no syllabus data exists for that code.
 */
export function getSyllabusTopics(subjectCode: string): SyllabusTopic[] | null {
  return SYLLABUS[subjectCode] ?? null;
}

/**
 * Build a prompt-friendly string of syllabus topics for a given subject.
 * Used by the Gemini extraction prompt to constrain topic classification.
 *
 * Example output:
 *   "B2 Cells, B2.1 Cell structure, B5.1 Plant nutrition (photosynthesis), ..."
 */
export function formatSyllabusForPrompt(subjectCode: string): string | null {
  const topics = getSyllabusTopics(subjectCode);
  if (!topics) return null;
  return topics.map((t) => `${t.code} ${t.topic}`).join(', ');
}
