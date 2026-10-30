// Le jeu des 10 biens tests de M17, inventés, chacun calculé à la main ligne par ligne (centimes, points de base).
// Partagé par le calcul (Y03) et le parcours des routes (Y07).
export interface Case {
  inputs: { price: number; rate: number; works: number; area: number; rent: [number, number, number]; charges: number; tax: number; vacancy: number };
  expected: { fees: number; totalCost: number; monthlyRent: number; annualRent: number; collectedRent: number; netIncome: number; gross: [number, number, number]; net: [number, number, number] };
}

/** 10 biens tests inventés, chacun calculé à la main ligne par ligne (centimes, points de base). */
export const CASES: Case[] = [
  {
    // Bien 1 : prix 15000000 ; frais 15000000 × 750 / 10 000 = 1125000 ; coût 15000000 + 1125000 + 1000000 = 17125000.
    // Loyer 1235 × 4500 / 100 = 55575 par mois, 666900 par an ; brut 666900 × 10 000 / 17125000 = 389 pb.
    // Perçu 55575 × (12 − 1) = 611325 ; net 611325 − 60000 − 90000 = 461325 ; 461325 × 10 000 / 17125000 = 269 pb.
    // Fourchette : loyer 1010 et 1501 au m².
    inputs: { price: 15000000, rate: 750, works: 1000000, area: 4500, rent: [1235, 1010, 1501], charges: 60000, tax: 90000, vacancy: 1 },
    expected: { fees: 1125000, totalCost: 17125000, monthlyRent: 55575, annualRent: 666900, collectedRent: 611325, netIncome: 461325, gross: [318, 389, 473], net: [204, 269, 346] },
  },
  {
    // Bien 2 : prix 9800000 ; frais 9800000 × 750 / 10 000 = 735000 ; coût 9800000 + 735000 + 0 = 10535000.
    // Loyer 1450 × 2850 / 100 = 41325 par mois, 495900 par an ; brut 495900 × 10 000 / 10535000 = 471 pb.
    // Perçu 41325 × (12 − 1) = 454575 ; net 454575 − 42000 − 61000 = 351575 ; 351575 × 10 000 / 10535000 = 334 pb.
    // Fourchette : loyer 1200 et 1700 au m².
    inputs: { price: 9800000, rate: 750, works: 0, area: 2850, rent: [1450, 1200, 1700], charges: 42000, tax: 61000, vacancy: 1 },
    expected: { fees: 735000, totalCost: 10535000, monthlyRent: 41325, annualRent: 495900, collectedRent: 454575, netIncome: 351575, gross: [390, 471, 552], net: [259, 334, 408] },
  },
  {
    // Bien 3 : prix 21000000 ; frais 21000000 × 250 / 10 000 = 525000 ; coût 21000000 + 525000 + 0 = 21525000.
    // Loyer 1180 × 6200 / 100 = 73160 par mois, 877920 par an ; brut 877920 × 10 000 / 21525000 = 408 pb.
    // Perçu 73160 × (12 − 0) = 877920 ; net 877920 − 90000 − 115000 = 672920 ; 672920 × 10 000 / 21525000 = 313 pb.
    // Fourchette : loyer 1000 et 1350 au m².
    inputs: { price: 21000000, rate: 250, works: 0, area: 6200, rent: [1180, 1000, 1350], charges: 90000, tax: 115000, vacancy: 0 },
    expected: { fees: 525000, totalCost: 21525000, monthlyRent: 73160, annualRent: 877920, collectedRent: 877920, netIncome: 672920, gross: [346, 408, 467], net: [250, 313, 371] },
  },
  {
    // Bien 4 : prix 32000000 ; frais 32000000 × 780 / 10 000 = 2496000 ; coût 32000000 + 2496000 + 2500000 = 36996000.
    // Loyer 1020 × 9540 / 100 = 97308 par mois, 1167696 par an ; brut 1167696 × 10 000 / 36996000 = 316 pb.
    // Perçu 97308 × (12 − 1) = 1070388 ; net 1070388 − 150000 − 180000 = 740388 ; 740388 × 10 000 / 36996000 = 200 pb.
    // Fourchette : loyer 880 et 1190 au m².
    inputs: { price: 32000000, rate: 780, works: 2500000, area: 9540, rent: [1020, 880, 1190], charges: 150000, tax: 180000, vacancy: 1 },
    expected: { fees: 2496000, totalCost: 36996000, monthlyRent: 97308, annualRent: 1167696, collectedRent: 1070388, netIncome: 740388, gross: [272, 316, 368], net: [160, 200, 248] },
  },
  {
    // Bien 5 : prix 7500000 ; frais 7500000 × 750 / 10 000 = 562500 ; coût 7500000 + 562500 + 1500000 = 9562500.
    // Loyer 1300 × 3200 / 100 = 41600 par mois, 499200 par an ; brut 499200 × 10 000 / 9562500 = 522 pb.
    // Perçu 41600 × (12 − 2) = 416000 ; net 416000 − 50000 − 70000 = 296000 ; 296000 × 10 000 / 9562500 = 310 pb.
    // Fourchette : loyer 1100 et 1500 au m².
    inputs: { price: 7500000, rate: 750, works: 1500000, area: 3200, rent: [1300, 1100, 1500], charges: 50000, tax: 70000, vacancy: 2 },
    expected: { fees: 562500, totalCost: 9562500, monthlyRent: 41600, annualRent: 499200, collectedRent: 416000, netIncome: 296000, gross: [442, 522, 602], net: [243, 310, 376] },
  },
  {
    // Bien 6 : prix 18500000 ; frais 18500000 × 760 / 10 000 = 1406000 ; coût 18500000 + 1406000 + 500000 = 20406000.
    // Loyer 1100 × 7000 / 100 = 77000 par mois, 924000 par an ; brut 924000 × 10 000 / 20406000 = 453 pb.
    // Perçu 77000 × (12 − 1) = 847000 ; net 847000 − 110000 − 125000 = 612000 ; 612000 × 10 000 / 20406000 = 300 pb.
    // Fourchette : loyer 950 et 1300 au m².
    inputs: { price: 18500000, rate: 760, works: 500000, area: 7000, rent: [1100, 950, 1300], charges: 110000, tax: 125000, vacancy: 1 },
    expected: { fees: 1406000, totalCost: 20406000, monthlyRent: 77000, annualRent: 924000, collectedRent: 847000, netIncome: 612000, gross: [391, 453, 535], net: [243, 300, 375] },
  },
  {
    // Bien 7 : prix 13250000 ; frais 13250000 × 740 / 10 000 = 980500 ; coût 13250000 + 980500 + 850000 = 15080500.
    // Loyer 1215 × 5125 / 100 = 62269 par mois, 747228 par an ; brut 747228 × 10 000 / 15080500 = 495 pb.
    // Perçu 62269 × (12 − 1) = 684959 ; net 684959 − 78000 − 95500 = 511459 ; 511459 × 10 000 / 15080500 = 339 pb.
    // Fourchette : loyer 1000 et 1400 au m².
    inputs: { price: 13250000, rate: 740, works: 850000, area: 5125, rent: [1215, 1000, 1400], charges: 78000, tax: 95500, vacancy: 1 },
    expected: { fees: 980500, totalCost: 15080500, monthlyRent: 62269, annualRent: 747228, collectedRent: 684959, netIncome: 511459, gross: [408, 495, 571], net: [259, 339, 408] },
  },
  {
    // Bien 8 : prix 26000000 ; frais 26000000 × 250 / 10 000 = 650000 ; coût 26000000 + 650000 + 0 = 26650000.
    // Loyer 1050 × 8000 / 100 = 84000 par mois, 1008000 par an ; brut 1008000 × 10 000 / 26650000 = 378 pb.
    // Perçu 84000 × (12 − 0) = 1008000 ; net 1008000 − 130000 − 140000 = 738000 ; 738000 × 10 000 / 26650000 = 277 pb.
    // Fourchette : loyer 900 et 1200 au m².
    inputs: { price: 26000000, rate: 250, works: 0, area: 8000, rent: [1050, 900, 1200], charges: 130000, tax: 140000, vacancy: 0 },
    expected: { fees: 650000, totalCost: 26650000, monthlyRent: 84000, annualRent: 1008000, collectedRent: 1008000, netIncome: 738000, gross: [324, 378, 432], net: [223, 277, 331] },
  },
  {
    // Bien 9 : prix 6400000 ; frais 6400000 × 800 / 10 000 = 512000 ; coût 6400000 + 512000 + 3000000 = 9912000.
    // Loyer 1600 × 2500 / 100 = 40000 par mois, 480000 par an ; brut 480000 × 10 000 / 9912000 = 484 pb.
    // Perçu 40000 × (12 − 2) = 400000 ; net 400000 − 35000 − 48000 = 317000 ; 317000 × 10 000 / 9912000 = 320 pb.
    // Fourchette : loyer 1300 et 1900 au m².
    inputs: { price: 6400000, rate: 800, works: 3000000, area: 2500, rent: [1600, 1300, 1900], charges: 35000, tax: 48000, vacancy: 2 },
    expected: { fees: 512000, totalCost: 9912000, monthlyRent: 40000, annualRent: 480000, collectedRent: 400000, netIncome: 317000, gross: [393, 484, 575], net: [244, 320, 395] },
  },
  {
    // Bien 10 : prix 41000000 ; frais 41000000 × 770 / 10 000 = 3157000 ; coût 41000000 + 3157000 + 4000000 = 48157000.
    // Loyer 1000 × 12000 / 100 = 120000 par mois, 1440000 par an ; brut 1440000 × 10 000 / 48157000 = 299 pb.
    // Perçu 120000 × (12 − 1) = 1320000 ; net 1320000 − 240000 − 260000 = 820000 ; 820000 × 10 000 / 48157000 = 170 pb.
    // Fourchette : loyer 850 et 1150 au m².
    inputs: { price: 41000000, rate: 770, works: 4000000, area: 12000, rent: [1000, 850, 1150], charges: 240000, tax: 260000, vacancy: 1 },
    expected: { fees: 3157000, totalCost: 48157000, monthlyRent: 120000, annualRent: 1440000, collectedRent: 1320000, netIncome: 820000, gross: [254, 299, 344], net: [129, 170, 211] },
  },];
