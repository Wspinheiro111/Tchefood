/**
 * NF-e de compra FICTÍCIA para a demonstração e os testes da importação de XML.
 * Fornecedor, chave e protocolo são inventados (DVs válidos), destinada ao CNPJ do
 * estabelecimento de demonstração. Não tem valor fiscal.
 *
 * Itens:
 *  1. Refrigerante lata 350 ml, 2 CX com 12 (uTrib UN 24) — casa pelo EAN com "Refrigerante Lata", fator 12.
 *  2. Picanha bovina resfriada, 12,5 KG, com desconto e frete — produto novo.
 *  3. Carvão vegetal 5 kg, 4 SC — produto novo ou ignorado.
 *
 * vProd 1.165,55 − vDesc 18,75 + vFrete 13,20 + vST 9,60 = vNF 1.169,60
 */
import { SEED_TENANT } from './seed';

export const SAMPLE_NFE_ACCESS_KEY = '43261111222333000181550010000045211123456784';

export function sampleNfeXml(recipientCnpj: string = SEED_TENANT.cnpj): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe${SAMPLE_NFE_ACCESS_KEY}" versao="4.00">
      <ide>
        <cUF>43</cUF><cNF>12345678</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>4521</nNF>
        <dhEmi>2026-11-06T09:42:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>4314902</cMunFG>
        <tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>4</cDV><tpAmb>1</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>9</indPres><procEmi>0</procEmi><verProc>1.0</verProc>
      </ide>
      <emit>
        <CNPJ>11222333000181</CNPJ><xNome>DISTRIBUIDORA PAMPA ALIMENTOS LTDA (EXEMPLO)</xNome><xFant>Pampa Distribuidora</xFant>
        <enderEmit><xLgr>Av. Exemplo</xLgr><nro>100</nro><xBairro>Centro</xBairro><cMun>4314902</cMun><xMun>Porto Alegre</xMun><UF>RS</UF><CEP>90000000</CEP></enderEmit>
        <IE>0960000000</IE><CRT>3</CRT>
      </emit>
      <dest>
        <CNPJ>${recipientCnpj}</CNPJ><xNome>GALPAO CRIOULO GASTRONOMIA CAMPEIRA LTDA</xNome>
        <enderDest><xLgr>Rua Exemplo</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>4314902</cMun><xMun>Porto Alegre</xMun><UF>RS</UF></enderDest>
        <indIEDest>1</indIEDest>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>REF-350-12</cProd><cEAN>7890000000017</cEAN><xProd>REFRIGERANTE LATA 350ML CX C/12</xProd><NCM>22021000</NCM><CEST>0300700</CEST><CFOP>5405</CFOP>
          <uCom>CX</uCom><qCom>2.0000</qCom><vUnCom>38.4000000000</vUnCom><vProd>76.80</vProd>
          <cEANTrib>7890000000017</cEANTrib><uTrib>UN</uTrib><qTrib>24.0000</qTrib><vUnTrib>3.2000000000</vUnTrib>
          <vFrete>3.20</vFrete><indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS><ICMS10><orig>0</orig><CST>10</CST><modBC>3</modBC><vBC>80.00</vBC><pICMS>17.00</pICMS><vICMS>13.60</vICMS><modBCST>4</modBCST><pMVAST>40.00</pMVAST><vBCST>136.47</vBCST><pICMSST>17.00</pICMSST><vICMSST>9.60</vICMSST></ICMS10></ICMS>
          <PIS><PISNT><CST>04</CST></PISNT></PIS><COFINS><COFINSNT><CST>04</CST></COFINSNT></COFINS>
        </imposto>
      </det>
      <det nItem="2">
        <prod>
          <cProd>CARNE-PIC-KG</cProd><cEAN>SEM GTIN</cEAN><xProd>PICANHA BOVINA RESFRIADA KG</xProd><NCM>02013000</NCM><CFOP>5102</CFOP>
          <uCom>KG</uCom><qCom>12.5000</qCom><vUnCom>79.9000000000</vUnCom><vProd>998.75</vProd>
          <cEANTrib>SEM GTIN</cEANTrib><uTrib>KG</uTrib><qTrib>12.5000</qTrib><vUnTrib>79.9000000000</vUnTrib>
          <vFrete>10.00</vFrete><vDesc>18.75</vDesc><indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>990.00</vBC><pICMS>7.00</pICMS><vICMS>69.30</vICMS></ICMS00></ICMS>
          <PIS><PISNT><CST>06</CST></PISNT></PIS><COFINS><COFINSNT><CST>06</CST></COFINSNT></COFINS>
        </imposto>
      </det>
      <det nItem="3">
        <prod>
          <cProd>CARVAO-5KG</cProd><cEAN>SEM GTIN</cEAN><xProd>CARVAO VEGETAL SACO 5KG</xProd><NCM>44029000</NCM><CFOP>5102</CFOP>
          <uCom>SC</uCom><qCom>4.0000</qCom><vUnCom>22.5000000000</vUnCom><vProd>90.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib><uTrib>SC</uTrib><qTrib>4.0000</qTrib><vUnTrib>22.5000000000</vUnTrib><indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>90.00</vBC><pICMS>17.00</pICMS><vICMS>15.30</vICMS></ICMS00></ICMS>
          <PIS><PISAliq><CST>01</CST><vBC>90.00</vBC><pPIS>1.65</pPIS><vPIS>1.49</vPIS></PISAliq></PIS>
          <COFINS><COFINSAliq><CST>01</CST><vBC>90.00</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>6.84</vCOFINS></COFINSAliq></COFINS>
        </imposto>
      </det>
      <total>
        <ICMSTot>
          <vBC>1160.00</vBC><vICMS>98.20</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>136.47</vBCST><vST>9.60</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
          <vProd>1165.55</vProd><vFrete>13.20</vFrete><vSeg>0.00</vSeg><vDesc>18.75</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>
          <vPIS>1.49</vPIS><vCOFINS>6.84</vCOFINS><vOutro>0.00</vOutro><vNF>1169.60</vNF>
        </ICMSTot>
      </total>
      <transp><modFrete>0</modFrete></transp>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>1</tpAmb><verAplic>RS20261106</verAplic><chNFe>${SAMPLE_NFE_ACCESS_KEY}</chNFe><dhRecbto>2026-11-06T09:42:10-03:00</dhRecbto>
      <nProt>143260000045210</nProt><digVal>EXEMPLO=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;
}
